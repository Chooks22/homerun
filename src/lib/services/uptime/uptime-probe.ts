import { stripAnsi } from "#lib/ansi.js";
import { config, serviceDomain } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { type ProbeResult, UptimeCheckDTO } from "#lib/dto/uptime-check-dto.js";
import {
	primaryHostname,
	type ServiceDomainFields,
} from "#lib/service-domains.js";
import { isDatabaseImage } from "#lib/service-link.js";
import { BaseScheduler } from "../cron/base-scheduler.ts";
import { DockerService } from "../docker.service.ts";
import {
	AlertDamper,
	detectTransitions,
	StatusAlertService,
} from "../status-alert.service.ts";
import { uptimeProbesQuiet } from "./quiet.ts";

const TIMEOUT_MS = 5000;

const RETRY_DELAY_MS = 2000;

/** One in this many ticks also prunes, same amortized shape as the stats sampler. */
const PRUNE_EVERY_TICKS = 60;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const UNTRUSTED_CERT_NOTE =
	"certificate not trusted (self-signed, or not issued yet)";

/**
 * Why the external probe can't mean anything for this hostname, or null when
 * it can. A `localhost` base domain is the dev/first-boot default and the
 * "public" hostname then resolves to this machine, so probing it proves
 * nothing about whether anyone else can reach the service : reporting that as
 * an outage would be noise, and reporting it as up would be a lie.
 */
export function externalProbeSkipReason(host: string): string | null {
	const bare = host.split(/[:/]/)[0]?.toLowerCase() ?? "";
	if (LOOPBACK_HOSTS.has(bare) || bare.endsWith(".localhost")) {
		return `${host} is a loopback address, so there's nothing to reach from outside this machine. Set a real base domain in Settings → General.`;
	}
	return null;
}

/** The hostname a service is published at, or null when it isn't published. */
export function externalHostFor(
	svc: ServiceDomainFields & { dnsResolvable: boolean },
): string | null {
	if (!svc.dnsResolvable) {
		return null;
	}
	return primaryHostname(svc, null, serviceDomain());
}

export type InternalProbeMethod = "healthcheck" | "http" | "tcp";

/** Which internal probe to use for a service: its own Docker healthcheck when it has one, else a raw TCP connect for a database image, else an HTTP request. */
/**
 * Whether the uptime loop probes this service: probing on, a deployed
 * workload, and running (the loop's own query plus its filter). Anything
 * showing probe results filters through this, so a probe turned off or a
 * stopped service stops showing its last beat as a live failure.
 */
export function isProbed(svc: {
	containerId: string | null;
	currentStatus: string;
	swarmServiceId: string | null;
	uptimeEnabled: boolean;
}): boolean {
	return (
		svc.uptimeEnabled &&
		svc.currentStatus === "running" &&
		Boolean(svc.containerId || svc.swarmServiceId)
	);
}

export function internalProbeMethod(
	image: string,
	hasHealthcheck: boolean,
): InternalProbeMethod {
	if (hasHealthcheck) {
		return "healthcheck";
	}
	return isDatabaseImage(image) ? "tcp" : "http";
}

/** Normalizes a probe failure into a short, human-readable message (timeout, connection refused, TLS), trimming Node's verbose error suffixes. */
export function probeErrorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const message = raw.split("For more information")[0]?.trim() || raw;
	if (/timed? ?out|aborted/i.test(message)) {
		return "Timed out.";
	}
	if (/refused|failed to connect/i.test(message)) {
		return "Connection refused.";
	}
	if (/certificate|tls|ssl/i.test(message)) {
		return `TLS failed: ${message}`;
	}
	return message;
}

/** Whether an error looks like a TLS/certificate failure rather than a transport-level one. */
export function isCertificateError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /certificate|tls|ssl/i.test(message);
}

const REQUIRED_BY_BUN_CONNECT = () => undefined;

/**
 * Opens a raw TCP connection to `host`:`port` and closes it as soon as it's
 * established, used as the liveness check for database images with no HTTP
 * server to probe.
 *
 * @throws When the connection can't be established, or after `timeoutMs`.
 */
export function tcpConnect(
	host: string,
	port: number,
	timeoutMs: number = TIMEOUT_MS,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("Timed out."));
		}, timeoutMs);
		let settled = false;
		const settle = (err?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			} else {
				resolve();
			}
		};
		Bun.connect({
			hostname: host,
			port,
			socket: {
				connectError: (_socket, err) => settle(err),
				data: REQUIRED_BY_BUN_CONNECT,
				error: (_socket, err) => settle(err),
				open: (socket) => {
					socket.end();
					settle();
				},
			},
		}).catch(settle);
	});
}

/**
 * Two liveness probes per service, every minute:
 *
 * - **internal**: does the container's own port answer on the Docker network?
 *   This is what a sibling service sees, and it fails on a crashed process
 *   inside a container the daemon still calls "running".
 * - **external**: does the hostname Traefik publishes actually answer? This
 *   fails on DNS, on a missing route, on a certificate, on a tunnel that isn't
 *   up — none of which the internal probe can see.
 *
 * Any HTTP response counts as alive, including 401/403 (a service behind the
 * login wall is up, it's just refusing *you*) and 404 (the app answered, it
 * just has no route at `/`). Only a transport-level failure or a timeout is a
 * failure.
 */
export class UptimeProbe extends BaseScheduler {
	protected readonly label = "Uptime";

	protected readonly runOnStart = true;

	#ticks = 0;

	readonly #damper = new AlertDamper();

	/**
	 * One uptime-check cycle: probes every uptime-enabled service internally
	 * and externally, persists the results, dispatches notifications for any
	 * up/down transitions, damped so a flapping service alerts once
	 * (`AlertDamper`, `StatusAlertService.dispatch`), and, once every
	 * `PRUNE_EVERY_TICKS` ticks, prunes old check rows. Skipped entirely
	 * inside a quiet window (`quietUptimeProbes`): a disruption Homerun causes
	 * on purpose isn't an outage.
	 */
	protected async tick(): Promise<void> {
		if (uptimeProbesQuiet()) {
			return;
		}
		this.#ticks += 1;

		const services = (await ServiceDTO.listRunningWithContainers()).filter(
			(svc) => svc.uptimeEnabled && (svc.containerId || svc.swarmServiceId),
		);
		const previous = await UptimeCheckDTO.latestByProbe(
			services.map((svc) => svc.id),
		);

		const probes = services.flatMap((svc) => [
			this.probeInternal(svc),
			this.#external(svc),
		]);
		const results = (await Promise.all(probes)).filter((r) => r !== null);
		await UptimeCheckDTO.recordMany(results);

		const transitions = this.#damper.alerts(
			detectTransitions(previous, results),
			results,
			Date.now(),
		);
		if (transitions.length > 0) {
			await StatusAlertService.dispatch(
				transitions,
				new Map(
					services.map((svc) => [svc.id, { host: externalHostFor(svc), svc }]),
				),
			);
		}

		if (this.#ticks % PRUNE_EVERY_TICKS === 0) {
			await UptimeCheckDTO.prune();
		}
	}

	/**
	 * Probes a service from inside the Docker network: its own healthcheck if
	 * it has one, else TCP or HTTP against its container address, or against
	 * its overlay alias for a swarm service. A swarm service with no running
	 * task on this node records a failure. The revision health watch calls it
	 * too, to hold a deploy until the service actually answers.
	 */
	async probeInternal(svc: ServiceDTO): Promise<ProbeResult> {
		const containerId =
			svc.containerId ||
			(svc.swarmServiceId
				? await DockerService.getRunningTaskContainerId(svc.swarmServiceId)
				: null);
		if (!containerId) {
			return {
				detail: "No running task on this node.",
				kind: "internal",
				ok: false,
				serviceId: svc.id,
			};
		}

		const health = await DockerService.containerHealth(containerId);
		const method = internalProbeMethod(svc.image, health !== null);
		if (method === "healthcheck" && health) {
			const output = health.output ? stripAnsi(health.output).trim() : "";
			return {
				detail: `Healthcheck: ${health.status}${output ? ` · ${output.slice(0, 120)}` : ""}`,
				kind: "internal",
				ok: health.status !== "unhealthy",
				serviceId: svc.id,
				target: "docker healthcheck",
			};
		}

		const address = svc.containerId
			? await DockerService.containerAddress(svc.containerId)
			: svc.slug;
		if (!address) {
			return {
				detail: "The container has no address on the Docker network.",
				kind: "internal",
				ok: false,
				serviceId: svc.id,
			};
		}

		return method === "tcp"
			? await this.#tcpProbe(svc.id, address, svc.containerPort)
			: await this.#probe(
					svc.id,
					"internal",
					`http://${address}:${svc.containerPort}/`,
				);
	}

	/** Internal probe for a database-image service: a raw TCP connect, no HTTP request. */
	async #tcpProbe(
		serviceId: string,
		host: string,
		port: number,
	): Promise<ProbeResult> {
		const startedAt = Date.now();
		const target = `tcp://${host}:${port}`;
		try {
			await tcpConnect(host, port);
			return {
				detail: "Port accepting connections",
				kind: "internal",
				latencyMs: Date.now() - startedAt,
				ok: true,
				serviceId,
				target,
			};
		} catch (err) {
			return {
				detail: probeErrorMessage(err),
				kind: "internal",
				latencyMs: Date.now() - startedAt,
				ok: false,
				serviceId,
				target,
			};
		}
	}

	/** Probes a service's publicly published hostname over HTTP(S), or null when it isn't published or externally reachable to probe (see `externalHostFor`/`externalProbeSkipReason`). */
	async #external(svc: ServiceDTO): Promise<ProbeResult | null> {
		const host = externalHostFor(svc);
		if (!host || externalProbeSkipReason(host)) {
			return null;
		}
		const scheme = config.traefik.entrypoint === "web" ? "http" : "https";
		return await this.#probe(svc.id, "external", `${scheme}://${host}/`);
	}

	/**
	 * Issues the underlying HTTP request for a probe, without following
	 * redirects, optionally skipping TLS verification. Each attempt opens its
	 * own connection: a pooled one left idle since the last tick may have been
	 * dropped by Traefik or the edge, and reusing it fails with a reset that
	 * says nothing about the service. A transport failure other than a
	 * certificate error is retried once after `RETRY_DELAY_MS`.
	 */
	async #request(target: string, verifyTls: boolean): Promise<Response> {
		const attempt = () =>
			fetch(target, {
				keepalive: false,
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
				tls: { rejectUnauthorized: verifyTls },
			});
		try {
			return await attempt();
		} catch (err) {
			if (isCertificateError(err)) {
				throw err;
			}
			await Bun.sleep(RETRY_DELAY_MS);
			return await attempt();
		}
	}

	/**
	 * HTTP probe of `target`: any response under 500 counts as up, a 5xx
	 * (an app reporting itself not ready, or a proxy with no live backend)
	 * as down. On a certificate
	 * error, retries once without verifying TLS so a self-signed/not-yet-
	 * issued cert is reported as "up, untrusted cert" rather than as down.
	 */
	async #probe(
		serviceId: string,
		kind: "internal" | "external",
		target: string,
	): Promise<ProbeResult> {
		const startedAt = Date.now();
		const failure = (err: unknown): ProbeResult => ({
			detail: probeErrorMessage(err),
			kind,
			latencyMs: Date.now() - startedAt,
			ok: false,
			serviceId,
			target,
		});

		try {
			const response = await this.#request(target, true);
			return {
				detail: `HTTP ${response.status}`,
				kind,
				latencyMs: Date.now() - startedAt,
				ok: response.status < 500,
				serviceId,
				target,
			};
		} catch (err) {
			if (!isCertificateError(err)) {
				return failure(err);
			}
			try {
				const response = await this.#request(target, false);
				return {
					detail: `HTTP ${response.status} · ${UNTRUSTED_CERT_NOTE}`,
					kind,
					latencyMs: Date.now() - startedAt,
					ok: response.status < 500,
					serviceId,
					target,
				};
			} catch (retryErr) {
				return failure(retryErr);
			}
		}
	}
}
