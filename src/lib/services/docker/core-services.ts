import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	applyEnv,
	DNS_CHALLENGE_RESOLVER,
	type DnsChallengeSetup,
	dnsChallengeFlags,
	httpreqEnv,
} from "#lib/acme-dns.js";
import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import { WorkerRequestError } from "#lib/server/worker-client.js";
import {
	quietUptimeProbes,
	TRAEFIK_RESTART_QUIET_MS,
} from "../uptime/quiet.ts";
import type { BaseDockerService, Constructor } from "./base.ts";
import { certResolverFor } from "./cert-resolver.ts";
import {
	DASHBOARD_ROUTER_FILE,
	dashboardHostFrom,
	dashboardRouterConfig,
	dashboardRouterPlan,
} from "./dashboard.ts";
import { MANAGED_LABEL } from "./labels.ts";
import { CORE_LABEL, type NewtEndpoint } from "./newt.ts";
import { SWARM_REFRESH_SECONDS, swarmNetworkName } from "./swarm.ts";
import {
	TRAEFIK_METRICS_COMMAND,
	TRAEFIK_METRICS_FLAGS,
} from "./traefik-metrics.ts";
import { tunnelTargetHostFrom } from "./tunnel.ts";

const LEADING_SLASH_RE = /^\//;

const logger = new Logger("Traefik");

export interface TraefikInfo {
	id: string;
	image: string;
	name: string;
}

export interface SelfContainer {
	aliases: string[];
	labels: Record<string, string>;
	name: string | null;
	networkAddress: string | null;
}

export const SOUIN_MODULE = "github.com/darkweak/souin";
export const SOUIN_VERSION = "v1.7.9";

export interface InfraContainer {
	id: string;
	image: string;
	name: string;
	project: string;
	service: string;
	state: string;
}

export interface TraefikUpdateResult {
	message: string;
	updated: boolean;
}

/**
 * Rewrites a Traefik command line so every `--key=value` in `flags` is
 * present exactly once: replaced where it already is, appended when absent,
 * removed for a null value. Everything keeps its place, and a bare boolean flag
 * counts as `true`, so a command that already has these flags comes back
 * identical and `applyTraefikFlags` leaves Traefik alone. Real bug: removing
 * and re-appending moved the flags to the end, the command never compared
 * equal, and every worker boot recreated Traefik three times, taking every
 * routed site down with it.
 */
export function applyFlags(
	cmd: string[],
	flags: Record<string, string | null>,
): string[] {
	const keyOf = (arg: string) =>
		arg.startsWith("--") ? arg.slice(2).split("=")[0]?.toLowerCase() : null;
	const wanted = new Map(
		Object.entries(flags).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const seen = new Set<string>();
	const next: string[] = [];
	for (const arg of cmd) {
		const key = keyOf(arg);
		if (key === null || key === undefined || !wanted.has(key)) {
			next.push(arg);
			continue;
		}
		const value = wanted.get(key);
		if (value === null || seen.has(key)) {
			continue;
		}
		seen.add(key);
		next.push(
			!arg.includes("=") && value === "true"
				? arg
				: `--${arg.slice(2).split("=")[0]}=${value}`,
		);
	}
	for (const [key, value] of Object.entries(flags)) {
		if (value !== null && !seen.has(key.toLowerCase())) {
			next.push(`--${key}=${value}`);
		}
	}
	return next;
}

export interface TraefikExpectation {
	acmeEmail: string | null;
	certResolver: string;
	dnsChallenge: DnsChallengeSetup | null;
	httpCache: boolean;
	swarm: boolean;
}

/**
 * The command-line flags the running Traefik needs for these settings, grouped
 * by what they're for, so a drift can be named in words. Only what the
 * settings turn on: a flag the settings don't ask for is left alone.
 */
export function expectedTraefikFlags(
	expectation: TraefikExpectation,
): Record<string, Record<string, string>> {
	const groups: Record<string, Record<string, string>> = {
		"the request metrics": TRAEFIK_METRICS_FLAGS,
	};
	if (expectation.swarm) {
		groups["the swarm provider"] = {
			"providers.swarm": "true",
			"providers.swarm.exposedByDefault": "false",
			"providers.swarm.network": swarmNetworkName(),
			"providers.swarm.refreshSeconds": String(SWARM_REFRESH_SECONDS),
		};
	}
	if (expectation.httpCache) {
		groups["the HTTP cache plugin"] = {
			"experimental.plugins.souin.modulename": SOUIN_MODULE,
			"experimental.plugins.souin.version": SOUIN_VERSION,
		};
	}
	if (expectation.dnsChallenge) {
		groups["the DNS challenge resolver"] = {
			[`certificatesresolvers.${DNS_CHALLENGE_RESOLVER}.acme.dnschallenge.provider`]:
				"httpreq",
		};
	}
	if (expectation.acmeEmail) {
		groups["the ACME email"] = {
			[`certificatesresolvers.${expectation.certResolver}.acme.email`]:
				expectation.acmeEmail,
		};
	}
	return groups;
}

/**
 * Which of `expected`'s groups the running Traefik's command is missing or
 * runs with another value. A bare boolean flag (`--providers.swarm`) counts as
 * `true`, and flag names match case-insensitively, as Traefik reads them.
 */
export function missingTraefikFlags(
	cmd: string[],
	expected: Record<string, Record<string, string>>,
): string[] {
	const given = new Map<string, string>();
	for (const arg of cmd) {
		if (!arg.startsWith("--")) {
			continue;
		}
		const [key = "", ...value] = arg.slice(2).split("=");
		given.set(key.toLowerCase(), value.length > 0 ? value.join("=") : "true");
	}
	return Object.entries(expected)
		.filter(([, flags]) =>
			Object.entries(flags).some(
				([key, value]) => given.get(key.toLowerCase()) !== value,
			),
		)
		.map(([group]) => group);
}

/**
 * The containers that belong to this instance's own stack: every container of
 * its compose project (`ownProject`, off its own container's labels) plus the
 * core containers Homerun starts itself (`homerun.core`), never a service it
 * deployed. Another compose stack on the same host (a leftover tunnel, an app
 * from another tool) isn't Homerun's and doesn't belong in its system logs.
 * With no known project (dev, no compose) any compose container counts.
 */
export function infraContainersFrom(
	containers: ListedContainer[],
	ownProject: string | null,
): InfraContainer[] {
	return containers
		.filter((container) => {
			const labels = container.Labels ?? {};
			if (labels[MANAGED_LABEL]) {
				return false;
			}
			const project = labels["com.docker.compose.project"];
			return Boolean(
				labels[CORE_LABEL] || (ownProject ? project === ownProject : project),
			);
		})
		.map((container) => {
			const labels = container.Labels ?? {};
			return {
				id: container.Id,
				image: container.Image,
				name:
					container.Names[0]?.replace(LEADING_SLASH_RE, "") ??
					container.Id.slice(0, 12),
				project:
					labels["com.docker.compose.project"] ??
					(labels[CORE_LABEL] ? "homerun" : ""),
				service:
					labels["com.docker.compose.service"] ?? labels[CORE_LABEL] ?? "",
				state: container.State,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** What this mixin needs from the swarm and container mixins, both merged ahead of it (see docker.service.ts). */
interface RequiresSwarmMixin {
	assertSwarmCapableDaemon: () => Promise<void>;
	ensureSharedNetwork: () => Promise<void>;
	ensureSwarmNetwork: (name: string) => Promise<void>;
	initSwarm: () => Promise<boolean>;
	removeSwarmService: (swarmServiceId: string) => Promise<void>;
	pullImage: (params: { image: string; tag: string }) => Promise<unknown>;
}

/** One row of the worker's container listing, as much of it as this file reads. */
export interface ListedContainer {
	HostConfig?: { NetworkMode?: string };
	Id: string;
	Image: string;
	Labels: Record<string, string> | null;
	Names: string[];
	NetworkSettings?: { Networks?: Record<string, unknown> };
	State: string;
}

/** A container inspect body, as much of it as this file reads. */
export interface InspectedContainer {
	Config: {
		Cmd?: string[];
		Env?: string[];
		Image: string;
		Labels?: Record<string, string>;
	};
	HostConfig: Record<string, unknown>;
	Id: string;
	Image: string;
	Name?: string;
	NetworkSettings?: {
		Networks?: Record<
			string,
			{ Aliases?: string[] | null; IPAMConfig?: unknown } & NewtEndpoint
		>;
	};
	State: { Running: boolean };
}

/**
 * Splits an image reference into the image and tag `pullImage` wants. A
 * reference with no tag pulls "latest", the same default the daemon applies.
 */
export function splitImageRef(ref: string): { image: string; tag: string } {
	const separator = ref.lastIndexOf(":");
	const slash = ref.lastIndexOf("/");
	if (separator === -1 || separator < slash) {
		return { image: ref, tag: "latest" };
	}
	return { image: ref.slice(0, separator), tag: ref.slice(separator + 1) };
}

/**
 * The network attachments to carry over when a container is recreated: only
 * the fields that decide which networks it rejoins and under which aliases,
 * never the inspect-only ones the daemon assigns fresh (NetworkID, EndpointID,
 * Gateway, IPAddress).
 */
function endpointsToPreserve(
	info: InspectedContainer,
): Record<string, { Aliases?: string[] | null; IPAMConfig?: unknown }> {
	return Object.fromEntries(
		Object.entries(info.NetworkSettings?.Networks ?? {}).map(
			([netName, endpoint]) => [
				netName,
				{ Aliases: endpoint.Aliases, IPAMConfig: endpoint.IPAMConfig },
			],
		),
	);
}

/** Traefik container management : Homerun's own infra container, a deliberate narrow exception to the managed-label-only rule (see labels.ts). */
// oxlint-disable-next-line max-lines-per-function -- mixin factory: the body is a class definition, not a procedure
export function DockerCoreServicesMixin<
	TBase extends Constructor<BaseDockerService & RequiresSwarmMixin>,
>(Base: TBase) {
	return class DockerCoreServicesService extends Base {
		/**
		 * Inspects the container this app is itself running in (found by
		 * hostname, which Docker sets to the container id). Returns null when
		 * that lookup fails, e.g. running outside Docker in dev.
		 */
		async selfContainer(): Promise<SelfContainer | null> {
			const info = await this.worker
				.get<InspectedContainer>(`/v1/containers/${hostname()}/inspect`)
				.catch(() => null);
			if (!info) {
				return null;
			}
			const network =
				info.NetworkSettings?.Networks?.[config.docker.networkName];
			return {
				aliases: network?.Aliases ?? [],
				labels: info.Config?.Labels ?? {},
				name: info.Name?.replace(LEADING_SLASH_RE, "") || null,
				networkAddress: network?.IPAddress || null,
			};
		}

		/** This app's own container labels (see `selfContainer`), or null when it can't be found. */
		async selfContainerLabels(): Promise<Record<string, string> | null> {
			const self = await this.selfContainer();
			return self?.labels ?? null;
		}

		/**
		 * The host a Pangolin tunnel should point at: the Traefik container's
		 * name when a Newt tunnel and Traefik share a network (so the tunnel
		 * can reach it by that name), otherwise "localhost".
		 */
		async tunnelTargetHost(): Promise<string> {
			const containers = await this.worker
				.get<ListedContainer[]>("/v1/containers")
				.catch(() => [] as ListedContainer[]);
			return tunnelTargetHostFrom(containers);
		}

		/**
		 * Writes the Traefik dynamic-config file that routes the dashboard's
		 * own configured host to this app's container, always, even when the
		 * container's compose labels route that host too: the file router
		 * outranks the label one (`DASHBOARD_ROUTER_PRIORITY`), so the
		 * dashboard stays reachable when Traefik's Docker provider stalls on a
		 * wedged container. Removes the file only when there's no origin host;
		 * leaves it alone when this container can't be inspected. See
		 * `dashboardRouterPlan`. Writes under `config.traefik.dynamicConfigDir`;
		 * failures are logged, not thrown.
		 */
		async syncDashboardRouter(): Promise<void> {
			const dir = config.traefik.dynamicConfigDir;
			if (!dir) {
				return;
			}
			const path = join(dir, DASHBOARD_ROUTER_FILE);
			const host = dashboardHostFrom(config.auth.origin ?? null);
			const plan = dashboardRouterPlan(
				host,
				host ? await this.selfContainer() : null,
			);
			if (plan.action === "keep") {
				return;
			}
			if (plan.action === "remove" || !host) {
				await rm(path, { force: true }).catch((err) => {
					logger.warn("Couldn't remove the dashboard router config", err);
				});
				return;
			}

			try {
				await mkdir(dir, { recursive: true });
				await writeFile(
					path,
					dashboardRouterConfig({
						certResolver: certResolverFor(
							host,
							config.traefik.certResolver,
							config.pangolinEnabled,
							config.traefik.instanceCertNames,
						),
						entrypoint: config.traefik.entrypoint,
						host,
						target: `http://${plan.target}:${config.port}`,
					}),
				);
				logger.info(`Dashboard router published for ${host} -> ${plan.target}`);
			} catch (err) {
				logger.error(`Couldn't publish the dashboard router for ${host}`, err);
			}
		}

		/**
		 * Locates the Traefik container this app's `compose.yaml` bootstraps.
		 *
		 * This is a DELIBERATE, narrow exception to the "only touch
		 * containers this app created" rule (see labels.ts) : Traefik is
		 * core infrastructure this app depends on but doesn't manage the
		 * lifecycle of by default. Matched by image name, since compose
		 * project naming isn't guaranteed stable across setups (no-compose /
		 * standalone Traefik is a documented fallback too).
		 */
		async findTraefikContainer(): Promise<TraefikInfo | null> {
			const containers = await this.worker.get<ListedContainer[]>(
				"/v1/containers",
				{ all: "1" },
			);
			const match = containers.find((c) => c.Image.startsWith("traefik"));
			if (!match) {
				return null;
			}
			return {
				id: match.Id,
				image: match.Image,
				name:
					match.Names[0]?.replace(LEADING_SLASH_RE, "") ??
					match.Id.slice(0, 12),
			};
		}

		/**
		 * Restarts the Traefik container in place : same image, same config,
		 * just a process restart. Low-risk; use this for "Traefik seems
		 * stuck" without reaching for a full update.
		 */
		async restartTraefikContainer(): Promise<void> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				throw new Error("Traefik container not found.");
			}
			await this.worker.post(`/v1/containers/${traefik.id}/restart`);
			logger.info(`Traefik container restarted: ${traefik.id}`);
		}

		/**
		 * Recreates the Traefik container with `flags` merged into its own
		 * command line and `env` into its environment (a null removing the
		 * flag or variable), everything else (image, mounts, networks, ports)
		 * read back off the running container unchanged.
		 *
		 * The narrow "Traefik is core infrastructure this app doesn't own"
		 * exception findTraefikContainer documents, extended one step
		 * further: this *does* change the live container's command, which
		 * updateTraefikContainer deliberately doesn't. It has to. Traefik
		 * reads its ACME account email, its providers and its entrypoints
		 * from static configuration at process start, so a dashboard field
		 * that only writes a database row is a field that does nothing, which
		 * is exactly what "Setting a Let's Encrypt email in the UI does
		 * nothing" meant. Returns `updated: false` without touching anything
		 * when every flag and variable already holds the requested value.
		 */
		async applyTraefikFlags(
			flags: Record<string, string | null>,
			env: Record<string, string | null> = {},
		): Promise<TraefikUpdateResult> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				throw new Error("Traefik container not found.");
			}

			const info = await this.worker.get<InspectedContainer>(
				`/v1/containers/${traefik.id}/inspect`,
			);
			const cmd = info.Config.Cmd ?? [];
			const next = applyFlags(cmd, flags);
			const currentEnv = info.Config.Env ?? [];
			const nextEnv = applyEnv(currentEnv, env);
			const same = (a: string[], b: string[]) =>
				a.length === b.length && a.every((value, i) => value === b[i]);
			if (same(next, cmd) && same(nextEnv, currentEnv)) {
				return {
					message: "Traefik already runs with that configuration.",
					updated: false,
				};
			}

			const wasRunning = info.State.Running;
			await this.#recreate(
				traefik,
				info,
				{ Cmd: next, Env: nextEnv },
				wasRunning,
			);

			logger.info(`Traefik recreated with updated flags: ${next.join(" ")}`);
			return {
				message: "Traefik was recreated with the new configuration.",
				updated: true,
			};
		}

		/**
		 * The containers that make up this instance's own stack
		 * (`infraContainersFrom`): its own compose project (the app, Postgres,
		 * Traefik, whatever else that compose file starts) and the core
		 * containers Homerun runs itself. Deployed services are excluded by the
		 * managed label, they have their own pages.
		 *
		 * The same narrow "core infrastructure" exception findTraefikContainer
		 * documents, and read-only: this lists and streams logs, it never
		 * touches them.
		 */
		async listInfraContainers(): Promise<InfraContainer[]> {
			const [containers, self] = await Promise.all([
				this.worker.get<ListedContainer[]>("/v1/containers", { all: "1" }),
				this.selfContainer().catch(() => null),
			]);
			return infraContainersFrom(
				containers,
				self?.labels["com.docker.compose.project"] ?? null,
			);
		}

		/**
		 * Stops, removes and recreates a core container from its own inspected
		 * config with `changes` applied on top, reattaching it to the same
		 * networks under the same aliases, and starting it again only if it
		 * was running.
		 *
		 * Everything it recreates with is read back off the container that was
		 * already running; only what the caller names in `changes` differs.
		 * There is a brief routing gap while the old container is gone, and no
		 * rollback if the new one fails to start, because by then there is
		 * nothing left to roll back to.
		 */
		async #recreate(
			target: TraefikInfo,
			info: InspectedContainer,
			changes: Record<string, unknown>,
			wasRunning: boolean,
		): Promise<void> {
			quietUptimeProbes(TRAEFIK_RESTART_QUIET_MS);
			await this.worker.post(`/v1/containers/${target.id}/stop`).catch(() => {
				// Already stopped : the remove below still applies.
			});
			await this.worker.delete(`/v1/containers/${target.id}`);
			const created = await this.worker.post<{ id: string }>("/v1/containers", {
				body: {
					...info.Config,
					...changes,
					HostConfig: info.HostConfig,
					NetworkingConfig: { EndpointsConfig: endpointsToPreserve(info) },
				},
				name: target.name,
			});
			if (wasRunning) {
				await this.worker.post(`/v1/containers/${created.id}/start`);
			}
		}

		/**
		 * Attaches a container to one more network, ignoring "already
		 * attached" and, when `ignoreMissing`, a container that doesn't exist.
		 */
		async #connect(
			containerId: string,
			network: string,
			ignoreMissing = false,
		): Promise<void> {
			try {
				await this.worker.post(`/v1/containers/${containerId}/connect`, {
					aliases: [],
					network,
				});
				logger.info(`${containerId} attached to ${network}`);
			} catch (err) {
				const status = err instanceof WorkerRequestError ? err.status : 0;
				const ignored = [403, 409, ...(ignoreMissing ? [404] : [])];
				if (!ignored.includes(status)) {
					throw err;
				}
			}
		}

		/**
		 * Everything switching the dashboard's orchestration mode to Swarm
		 * actually requires on the host, in order: `docker swarm init` (this
		 * daemon has to be a manager before a single service can be created),
		 * an **attachable overlay** network for those services to share,
		 * this app and Traefik attached to it (the app so the uptime probe
		 * reaches swarm services by alias), and Traefik's swarm provider turned on so it
		 * discovers them at all. Before this, flipping that select only wrote
		 * a database row and every swarm deploy failed on a daemon that
		 * wasn't in a swarm.
		 *
		 * Reports what it did as a list of lines rather than throwing on a
		 * missing Traefik : the mode is still worth saving on a host whose
		 * proxy lives elsewhere, the admin just has to wire that end up.
		 *
		 * @throws Before touching the host when the daemon runs rootless.
		 */
		async enableSwarmMode(): Promise<string[]> {
			await this.assertSwarmCapableDaemon();
			const steps: string[] = [];
			steps.push(
				(await this.initSwarm())
					? "Initialised a new swarm on this host."
					: "This host is already a swarm manager.",
			);

			const network = swarmNetworkName();
			await this.ensureSwarmNetwork(network);
			steps.push(`Overlay network ${network} is ready.`);
			await this.#connect(hostname(), network, true);

			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				steps.push(
					`No Traefik container on this host : attach your proxy to ${network} and turn on its swarm provider by hand.`,
				);
				return steps;
			}

			await this.#connect(traefik.id, network);
			const applied = await this.applyTraefikFlags({
				"providers.swarm": "true",
				"providers.swarm.exposedByDefault": "false",
				"providers.swarm.network": network,
				"providers.swarm.refreshSeconds": String(SWARM_REFRESH_SECONDS),
			});
			steps.push(applied.message);
			return steps;
		}

		/**
		 * Turns Traefik's swarm provider back off. Deliberately leaves the
		 * swarm itself running : `docker swarm leave --force` would kill every
		 * swarm service on the host, including ones this app didn't create,
		 * which is not a thing a dashboard select should do behind your back.
		 */
		async disableSwarmMode(): Promise<string[]> {
			if (!(await this.findTraefikContainer())) {
				return ["No Traefik container on this host : nothing to undo."];
			}
			const applied = await this.applyTraefikFlags({
				"providers.swarm": null,
				"providers.swarm.exposedByDefault": null,
				"providers.swarm.network": null,
				"providers.swarm.refreshSeconds": null,
			});
			return [
				applied.message,
				"The swarm itself is left running : run `docker swarm leave --force` yourself if you want it gone.",
			];
		}

		/**
		 * Loads or unloads the Souin HTTP cache plugin into Traefik, which a
		 * service's "Cache responses" setting needs: plugins are static
		 * configuration, so this recreates Traefik when it changes anything.
		 */
		async applyHttpCache(enabled: boolean): Promise<TraefikUpdateResult> {
			return await this.applyTraefikFlags({
				"experimental.plugins.souin.modulename": enabled ? SOUIN_MODULE : null,
				"experimental.plugins.souin.version": enabled ? SOUIN_VERSION : null,
			});
		}

		/**
		 * Which parts of the Traefik configuration the settings call for the
		 * running container lacks, in words ("the HTTP cache plugin"), or null
		 * when there's no Traefik container to compare against.
		 */
		async traefikDrift(
			expectation: TraefikExpectation,
		): Promise<string[] | null> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				return null;
			}
			const info = await this.worker.get<InspectedContainer>(
				`/v1/containers/${traefik.id}/inspect`,
			);
			return missingTraefikFlags(
				info.Config.Cmd ?? [],
				expectedTraefikFlags(expectation),
			);
		}

		/**
		 * Puts every Traefik flag the settings call for back onto the running
		 * container: swarm mode (network attachments included) when that's the
		 * orchestration mode, then the request metrics, the HTTP cache plugin
		 * and the ACME email.
		 * Recreating Traefik from the compose file (`docker compose up
		 * --force-recreate`, a self-update) drops all of them. Each step is
		 * independent: one failing is reported and the others still run.
		 *
		 * @returns A line per step that failed, empty when all of them held.
		 */
		async reassertTraefikConfig(
			expectation: TraefikExpectation,
		): Promise<string[]> {
			const failures: string[] = [];
			const attempt = async (what: string, step: () => Promise<unknown>) => {
				await step().catch((err: unknown) => {
					failures.push(
						`${what}: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			};
			if (expectation.swarm) {
				await attempt("swarm mode", () => this.enableSwarmMode());
			}
			await attempt("request metrics", () =>
				this.applyTraefikFlags(TRAEFIK_METRICS_FLAGS),
			);
			await attempt("HTTP cache plugin", () =>
				this.applyHttpCache(expectation.httpCache),
			);
			if (expectation.acmeEmail) {
				const email = expectation.acmeEmail;
				await attempt("ACME email", () => this.applyAcmeEmail(email));
			}
			await attempt("DNS challenge resolver", () =>
				this.applyDnsChallenge(expectation.dnsChallenge),
			);
			return failures;
		}

		/** Traefik's Prometheus metrics, read inside its container so nothing is published; null when unreadable. */
		async traefikMetrics(): Promise<string | null> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				return null;
			}
			const result = await this.worker
				.post<{ exitCode: number; stdout: string }>("/v1/exec", {
					cmd: TRAEFIK_METRICS_COMMAND,
					container: traefik.id,
				})
				.catch(() => null);
			return result?.exitCode === 0 ? result.stdout : null;
		}

		/**
		 * Puts the ACME account email Settings → Networking holds onto the
		 * running Traefik, which is the only place it means anything : Traefik
		 * reads it from static configuration at startup, so the field used to
		 * be recorded and never applied.
		 */
		async applyAcmeEmail(email: string | null): Promise<TraefikUpdateResult> {
			const key = `certificatesresolvers.${config.traefik.certResolver}.acme.email`;
			return await this.applyTraefikFlags({ [key]: email });
		}

		/**
		 * Declares the DNS-01 resolver on the running Traefik, solving its
		 * challenges through lego's httpreq provider against this app, or
		 * removes it with a null `setup`. It shares the HTTP-01 resolver's
		 * storage file and account email, read off the running command.
		 * Recreates Traefik only when something changes.
		 *
		 * @throws When there's no Traefik container.
		 */
		async applyDnsChallenge(
			setup: DnsChallengeSetup | null,
		): Promise<TraefikUpdateResult> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				throw new Error("Traefik container not found.");
			}
			const info = await this.worker.get<InspectedContainer>(
				`/v1/containers/${traefik.id}/inspect`,
			);
			return await this.applyTraefikFlags(
				dnsChallengeFlags(
					config.traefik.certResolver,
					setup !== null,
					info.Config.Cmd ?? [],
					config.traefik.acmeEmail ?? null,
				),
				httpreqEnv(setup),
			);
		}

		/**
		 * Pulls the latest image for whatever tag Traefik is *currently*
		 * running (read off the live container, e.g. "traefik:v3.1" : this
		 * never changes which tag is tracked) and, only if that pull
		 * actually produced a new image id, recreates the container from its
		 * own already-running Config/HostConfig/network attachments with
		 * just the image swapped in.
		 *
		 * This is the same narrow exception `findTraefikContainer` documents,
		 * extended to a mutating operation: it deliberately never invents new
		 * command-line flags or mounts (see custom-ssl.ts's "this app never
		 * modifies the live Traefik container's command/mounts itself"
		 * stance) : everything it recreates with is read back from
		 * `inspect()` on the container that's already running, byte-for-byte,
		 * only the image digest changes. There's a brief routing gap while
		 * the old container is removed and the new one starts, and no
		 * automatic rollback if the new container fails to start (nothing to
		 * roll back to : the old one is already gone).
		 */
		async updateTraefikContainer(): Promise<TraefikUpdateResult> {
			const traefik = await this.findTraefikContainer();
			if (!traefik) {
				throw new Error("Traefik container not found.");
			}

			const info = await this.worker.get<InspectedContainer>(
				`/v1/containers/${traefik.id}/inspect`,
			);
			const ref = info.Config.Image;

			logger.info(`Pulling latest image for Traefik: ${ref}`);
			await this.pullImage(splitImageRef(ref));

			const pulled = await this.worker.get<{ id: string | null }>(
				"/v1/images/id",
				{ ref },
			);
			if (pulled.id === info.Image) {
				logger.info(`Traefik already up to date: ${ref}`);
				return {
					message: `Already running the latest ${ref}.`,
					updated: false,
				};
			}

			logger.info(`Recreating Traefik container with updated image: ${ref}`);
			await this.#recreate(traefik, info, { Image: ref }, info.State.Running);

			logger.info(`Traefik updated and recreated: ${ref}`);
			return {
				message: `Updated to the latest ${ref} and restarted.`,
				updated: true,
			};
		}
	};
}
