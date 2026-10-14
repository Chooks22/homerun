import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import type { AuthPathsMode } from "#lib/path-patterns.js";
import {
	type PublishedPort,
	portBindings,
	portKey,
} from "#lib/published-ports.js";
import type { ContainerStatus } from "#lib/types.js";
import { decryptSecret } from "../secrets.ts";
import type { BaseDockerService, Constructor } from "./base.ts";
import type { RemoteHostConnection } from "./client.ts";
import { errorPagesPublished } from "./error-pages.ts";
import { buildContainerLabels } from "./labels.ts";
import { READINESS_LABEL } from "./readiness.ts";
import {
	type ContainerRuntimeParams,
	mergeLabels,
	runtimeArgv,
	runtimeHostConfig,
} from "./runtime-options.ts";

export type { ContainerStatus } from "#lib/types.js";
export type { RemoteHostConnection } from "./client.ts";

const logger = new Logger("Docker");

export interface RegistryAuth {
	password: string;
	serveraddress?: string;
	username: string;
}

export interface PullProgressEvent {
	id?: string;
	status: string;
}

export interface PullImageParams {
	image: string;
	tag: string;
	auth?: RegistryAuth;
	onProgress?: (line: string) => void;
	remote?: RemoteHostConnection | null;
}

export interface AppliedHealthcheck {
	generated: boolean;
	interval: number | null;
	log: { at: string | null; exitCode: number | null; output: string | null }[];
	retries: number | null;
	startPeriod: number | null;
	status: string | null;
	test: string | null;
	timeout: number | null;
}

export interface ContainerSample {
	cpuPercent: number;
	memLimitMb: number;
	memUsedMb: number;
	netRxBytes: number;
	netTxBytes: number;
}

interface PullStreamLine {
	done?: boolean;
	error?: string;
	id?: string;
	status?: string;
}

/**
 * Drains the worker's NDJSON pull progress into `onProgress`, one line per
 * layer status change, and throws whatever the terminating `{done:true}` line
 * reports as an error.
 *
 * The worker already collapses the daemon's per-byte-range progress down to
 * one event per layer status change; the map here is the second half of that,
 * dropping a repeated status for a layer the deploy log has already narrated.
 */
async function consumePullProgress(
	stream: ReadableStream<Uint8Array>,
	onProgress?: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const lastStatusById = new Map<string, string>();

	const consume = (line: string): string | null => {
		const trimmed = line.trim();
		if (trimmed === "") {
			return null;
		}
		const event = JSON.parse(trimmed) as PullStreamLine;
		if (event.done) {
			return event.error ?? null;
		}
		if (!event.status) {
			return null;
		}
		const key = event.id ?? "";
		if (lastStatusById.get(key) !== event.status) {
			lastStatusById.set(key, event.status);
			onProgress?.(event.id ? `${event.status}: ${event.id}` : event.status);
		}
		return null;
	};

	let buffer = "";
	let failure: string | null = null;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time by definition
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			failure = consume(line) ?? failure;
		}
	}
	failure = consume(buffer) ?? failure;

	if (failure) {
		throw new Error(failure);
	}
}

export interface VolumeMountParams {
	containerPath: string;
	readOnly: boolean;
	// A bind-mount host path ("/mnt/data/foo") or a Docker-managed named
	// volume name : see StorageVolume in the schema, same field either way.
	source: string;
}

export interface CreateContainerParams {
	containerPort: number;
	cpuLimit?: string | null;
	defaultDomainEnabled?: boolean;
	// When false, the container gets no Traefik labels at all : no public
	// <slug>.<baseDomain>, subnet-only reachability. Defaults to true.
	dnsResolvable?: boolean;
	domainPorts?: Record<string, number>;
	stripPathDomains?: string[];
	authPaths?: string[];
	authPathsMode?: AuthPathsMode;
	authRequired?: boolean;
	blockedPaths?: string[];
	httpCacheTtl?: number | null;
	domains?: string[];
	envVars: Record<string, string>;
	image: string;
	memoryLimitMb?: number | null;
	// "bridge" (default) | "host" : shares the host's network namespace
	// directly instead of joining the shared/stack Docker networks, for
	// apps that need it (mDNS/SSDP discovery, e.g. Home Assistant). Docker
	// doesn't allow combining host mode with any other network attachment,
	// so when this is "host": no shared-network alias, no stack-network
	// join, no Traefik labels regardless of dnsResolvable (there's no
	// container-specific IP/network for Traefik's docker provider to route
	// to) : the container is reachable only directly on the host's own
	// network interfaces, on whatever port(s) it binds to itself.
	networkMode?: "bridge" | "host";
	// When set, the container also joins this stack's dedicated network
	// (see docker/networks.ts) : lets sibling services in the same stack
	// reach it, in addition to the shared Traefik network below. No effect
	// when networkMode is "host" (see above).
	stackId?: string | null;
	// "tcp" (default) | "udp" | "both" : which protocol(s) containerPort is
	// declared under (Docker's ExposedPorts). Doesn't publish anything by
	// itself : publishedPorts does that; matters for host-visible
	// reachability only in combination with networkMode: "host" above.
	portProtocol?: "tcp" | "udp" | "both";
	publishedPorts?: PublishedPort[];
	// Prefixes the container name and public subdomain when the service
	// belongs to a stack (e.g. "<stackSlug>-<slug>.<baseDomain>").
	stackSlug?: string | null;
	// When set, this container is created on a remote Docker daemon instead
	// of the local socket : see RemoteHostConnection. Note: the
	// shared/stack Docker networks and Traefik itself all live on the
	// *local* host, so a remote-hosted service isn't reachable through the
	// normal internal-network or Traefik paths : only directly, if you
	// publish a port yourself. Effectively an isolated remote workload
	// today, not (yet) a fully integrated second node.
	remote?: RemoteHostConnection | null;
	healthcheckCommand?: string | null;
	restartPolicy: string;
	runtime?: ContainerRuntimeParams;
	serviceId: string;
	slug: string;
	tag: string;
	volumes?: VolumeMountParams[];
}

/**
 * Host mode shares the host's network namespace directly : Docker doesn't
 * allow combining it with any other network attachment (see
 * CreateContainerParams.networkMode), so it wins over everything else.
 * Otherwise the shared network only exists on the local host, so a remote
 * daemon gets Docker's own default bridge instead (no Traefik routing, no
 * internal service-discovery alias).
 */
function networkModeFor(params: CreateContainerParams): string | undefined {
	if (params.networkMode === "host") {
		return "host";
	}
	return params.remote ? undefined : config.docker.networkName;
}

/**
 * The Engine `HostConfig` for a service's container: volume binds (Docker's
 * `source:target[:ro]` form covers a host path and a named volume alike),
 * memory/CPU limits, network mode, restart policy and the runtime options.
 */
function containerHostConfig(params: CreateContainerParams) {
	const binds = (params.volumes ?? []).map(
		(v) => `${v.source}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
	);
	return {
		...runtimeHostConfig(params.runtime),
		Binds: binds.length > 0 ? binds : undefined,
		Memory: params.memoryLimitMb
			? params.memoryLimitMb * 1024 * 1024
			: undefined,
		NanoCpus: params.cpuLimit
			? Math.round(Number.parseFloat(params.cpuLimit) * 1e9)
			: undefined,
		NetworkMode: networkModeFor(params),
		PortBindings:
			params.networkMode === "host"
				? undefined
				: portBindings(params.publishedPorts ?? []),
		RestartPolicy: {
			Name: params.restartPolicy === "no" ? "" : params.restartPolicy,
		},
	};
}

/**
 * The container-creation body for a service, minus what depends on the image
 * the deploy actually resolved (`Env`, `Image`, the readiness `Healthcheck`
 * and label, the name): exposed ports, `HostConfig`, Traefik and tracking
 * labels (none for host networking, where Traefik has nothing to route to),
 * the shared-network alias and `Tty` (one unframed log stream). The homerun
 * worker fills in the rest.
 */
export function containerCreateTemplate(params: CreateContainerParams) {
	const isHostNetwork = params.networkMode === "host";
	const protocols =
		params.portProtocol === "both"
			? (["tcp", "udp"] as const)
			: [params.portProtocol ?? "tcp"];
	return {
		...runtimeArgv(params.runtime),
		ExposedPorts: Object.fromEntries([
			...protocols.map((proto) => [`${params.containerPort}/${proto}`, {}]),
			...(params.publishedPorts ?? []).map((port) => [portKey(port), {}]),
		]),
		HostConfig: containerHostConfig(params),
		Labels: mergeLabels(
			params.runtime?.labels,
			buildContainerLabels({
				authPaths: params.authPaths,
				authPathsMode: params.authPathsMode,
				authRequired: params.authRequired,
				blockedPaths: params.blockedPaths,
				containerPort: params.containerPort,
				defaultDomainEnabled: params.defaultDomainEnabled,
				dnsResolvable: isHostNetwork ? false : params.dnsResolvable,
				domainPorts: params.domainPorts,
				domains: params.domains,
				stripPathDomains: params.stripPathDomains,
				errorPages: !params.remote && errorPagesPublished(),
				httpCacheTtl: params.httpCacheTtl,
				serviceId: params.serviceId,
				slug: params.slug,
				stackSlug: params.stackSlug,
			}),
		),
		NetworkingConfig:
			isHostNetwork || params.remote
				? undefined
				: {
						EndpointsConfig: {
							[config.docker.networkName]: { Aliases: [params.slug] },
						},
					},
		Tty: true,
	};
}

/**
 * Container lifecycle : pull, start/stop/restart/remove, status inspection,
 * log streaming, stats and health sampling.
 */
// oxlint-disable-next-line max-lines-per-function -- mixin factory: the body is a class definition, not a procedure
export function DockerContainerMixin<
	TBase extends Constructor<BaseDockerService>,
>(Base: TBase) {
	return class DockerContainerService extends Base {
		/**
		 * Builds the registry authconfig the worker's pull route takes, from a
		 * service's stored credentials, decrypting the password. Returns
		 * undefined for public images (no registryUsername set).
		 */
		buildAuthConfig(service: {
			registryUrl: string | null;
			registryUsername: string | null;
			registryPasswordEnc: string | null;
		}): RegistryAuth | undefined {
			if (!service.registryUsername) {
				return;
			}

			const password = service.registryPasswordEnc
				? decryptSecret(service.registryPasswordEnc)
				: null;

			return {
				password: password ?? "",
				serveraddress: service.registryUrl ?? undefined,
				username: service.registryUsername,
			};
		}

		/**
		 * Pulls `image:tag` through the worker, optionally authenticating
		 * against a private registry, narrating each layer status change to
		 * `onProgress` as the worker reports it.
		 * @throws whatever the pull failed with, as the worker reported it.
		 */
		async pullImage(
			params: PullImageParams,
		): Promise<{ digest: string | null }> {
			const ref = `${params.image}:${params.tag}`;

			logger.info(`Pulling image: ${ref}`);
			params.onProgress?.(`Pulling ${ref}...`);

			const progress = await this.worker.stream("v1/images/pull", {
				body: { auth: params.auth, ref },
				method: "POST",
			});
			await consumePullProgress(progress, params.onProgress);

			const { digest } = await this.worker.get<{
				digest?: string | null;
				id: string | null;
			}>("v1/images/id", { ref });
			logger.info(`Pulled image: ${ref} digest=${digest || "unknown"}`);
			return { digest: digest || null };
		}

		/** Starts a stopped container. Already running isn't an error. */
		async startContainer(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<void> {
			await this.worker.post(`v1/containers/${containerId}/start`);
			logger.info(`Container started: ${containerId}`);
		}

		/** Stops a running container. Already stopped isn't an error. */
		async stopContainer(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<void> {
			await this.worker.post(`v1/containers/${containerId}/stop`);
			logger.info(`Container stopped: ${containerId}`);
		}

		/** Sends SIGKILL to a container, skipping the stop grace period. Already stopped isn't an error. */
		async killContainer(containerId: string): Promise<void> {
			await this.worker.post(`v1/containers/${containerId}/kill`);
			logger.info(`Container killed: ${containerId}`);
		}

		/** Restarts a container. */
		async restartContainer(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<void> {
			await this.worker.post(`v1/containers/${containerId}/restart`);
			logger.info(`Container restarted: ${containerId}`);
		}

		/** Removes a container, forcing removal (stopping it first) by default. One already gone isn't an error. */
		async removeContainer(
			containerId: string,
			opts?: { force?: boolean },
			_remote?: RemoteHostConnection | null,
		): Promise<void> {
			await this.worker.delete(`v1/containers/${containerId}`, {
				force: opts?.force === false ? undefined : "1",
			});
			logger.info(`Container removed: ${containerId}`);
		}

		/**
		 * A container's live state as our status enum. The mapping itself lives
		 * in the worker now, which also answers `missing` for a container the
		 * daemon no longer has rather than failing the call.
		 */
		async inspectStatus(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<ContainerStatus> {
			const { status } = await this.worker.get<{ status: ContainerStatus }>(
				`v1/containers/${containerId}/status`,
			);
			return status;
		}

		/**
		 * A container's combined stdout/stderr as a web ReadableStream: live
		 * and never-ending unless `follow` is false, in which case it's the
		 * last `tail` lines (default 200) and closes. The worker strips the
		 * daemon's stdout/stderr frame headers, so this is plain text.
		 */
		streamLogs(
			containerId: string,
			opts?: { tail?: number; follow?: boolean },
			_remote?: RemoteHostConnection | null,
		): Promise<ReadableStream<Uint8Array>> {
			return this.worker.stream(`v1/containers/${containerId}/logs`, {
				query: {
					follow: opts?.follow === false ? "0" : "1",
					tail: String(opts?.tail ?? 200),
				},
			});
		}

		/**
		 * One non-streaming `docker stats` sample for a container, in the
		 * units the graphs store (see schema.ts's stat_sample): CPU as a
		 * percentage of one host's worth of cores, memory in MB, and the
		 * network counters as the daemon reports them (cumulative since the
		 * container started, so rates are derived at read time).
		 *
		 * Null rather than a throw for anything that isn't running, which is
		 * the normal case for most of the list this is called over.
		 */
		sampleContainerStats(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<ContainerSample | null> {
			return this.worker.get<ContainerSample | null>(
				`v1/containers/${containerId}/stats`,
			);
		}

		/**
		 * The container's Docker healthcheck status and the last probe's
		 * output, or null when the container has no healthcheck configured,
		 * only has Homerun's generated readiness check, or can't be inspected.
		 */
		async containerHealth(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<{ output: string | null; status: string } | null> {
			const health = await this.worker.get<{
				output: string | null;
				status: string;
			} | null>(`v1/containers/${containerId}/health`);
			return health
				? { output: health.output?.trim() || null, status: health.status }
				: null;
		}

		/**
		 * The healthcheck the running container was actually created with
		 * (the service's, the image's, or Homerun's generated readiness
		 * check), timings in seconds, plus its live status and last probes.
		 * Null when the container can't be inspected.
		 */
		async containerHealthcheck(
			containerId: string,
		): Promise<AppliedHealthcheck | null> {
			const inspected = await this.worker
				.get<{
					Config?: {
						Healthcheck?: {
							Interval?: number;
							Retries?: number;
							StartPeriod?: number;
							Test?: string[];
							Timeout?: number;
						};
						Labels?: Record<string, string> | null;
					};
					State?: {
						Health?: {
							FailingStreak?: number;
							Log?: { End?: string; ExitCode?: number; Output?: string }[];
							Status?: string;
						};
					};
				}>(`v1/containers/${containerId}/inspect`)
				.catch(() => null);
			if (!inspected) {
				return null;
			}
			const check = inspected.Config?.Healthcheck;
			const test = check?.Test ?? [];
			const health = inspected.State?.Health;
			const seconds = (ns: number | undefined) =>
				ns ? Math.round(ns / 1_000_000_000) : null;
			return {
				generated: !!inspected.Config?.Labels?.[READINESS_LABEL],
				interval: seconds(check?.Interval),
				log: (health?.Log ?? []).map((entry) => ({
					at: entry.End ?? null,
					exitCode: entry.ExitCode ?? null,
					output: entry.Output?.trim() || null,
				})),
				retries: check?.Retries ?? null,
				startPeriod: seconds(check?.StartPeriod),
				status: health?.Status ?? null,
				test:
					test.length === 0 || test[0] === "NONE"
						? null
						: test[0] === "CMD-SHELL"
							? test.slice(1).join(" ")
							: test.slice(test[0] === "CMD" ? 1 : 0).join(" "),
				timeout: seconds(check?.Timeout),
			};
		}

		/**
		 * The labels a service's running workload was created with: the swarm
		 * service's spec labels, else the container's. Null when there's no
		 * workload or it can't be inspected.
		 */
		async workloadLabels(ids: {
			containerId: string | null;
			swarmServiceId: string | null;
		}): Promise<Record<string, string> | null> {
			if (ids.swarmServiceId) {
				const svc = await this.worker
					.get<{ Spec?: { Labels?: Record<string, string> | null } }>(
						`v1/swarm/services/${ids.swarmServiceId}`,
					)
					.catch(() => null);
				return svc ? (svc.Spec?.Labels ?? {}) : null;
			}
			if (!ids.containerId) {
				return null;
			}
			const inspected = await this.worker
				.get<{ Config?: { Labels?: Record<string, string> | null } }>(
					`v1/containers/${ids.containerId}/inspect`,
				)
				.catch(() => null);
			return inspected ? (inspected.Config?.Labels ?? {}) : null;
		}

		/** The container's own IP on the first network it's attached to, for the internal liveness probe. */
		async containerAddress(
			containerId: string,
			_remote?: RemoteHostConnection | null,
		): Promise<string | null> {
			const { address } = await this.worker.get<{ address: string | null }>(
				`v1/containers/${containerId}/address`,
			);
			return address;
		}
	};
}
