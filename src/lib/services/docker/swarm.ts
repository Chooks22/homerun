import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import type { AuthPathsMode } from "#lib/path-patterns.js";
import type { PublishedPort } from "#lib/published-ports.js";
import type { ContainerStatus } from "#lib/types.js";
import type { BaseDockerService, Constructor } from "./base.ts";
import type { RegistryAuth, VolumeMountParams } from "./containers.ts";
import { errorPagesPublished } from "./error-pages.ts";
import { buildContainerLabels, SERVICE_ID_LABEL } from "./labels.ts";
import {
	type ContainerRuntimeParams,
	capabilityName,
	mergeLabels,
} from "./runtime-options.ts";

const logger = new Logger("Swarm");

export const SWARM_REFRESH_SECONDS = 2;

/**
 * Swarm services can only join an **overlay** network, and the shared
 * network standalone containers use (`config.docker.networkName`) already
 * exists as a bridge on any instance that ever deployed anything, with
 * Traefik and the app itself attached to it. A live bridge network can't be
 * converted, so swarm mode gets its own attachable overlay alongside it
 * rather than fighting over one name : Traefik joins both and routes either
 * way.
 */
export function swarmNetworkName(): string {
	return `${config.docker.networkName}-swarm`;
}

/**
 * Whether `docker info`'s security options mark the daemon as rootless.
 * Swarm mode can't work there: a rootless daemon can't create the overlay
 * network a swarm service joins, and fails the attach with a bare "context
 * deadline exceeded" after the swarm was already initialised.
 */
export function isRootlessDaemon(
	securityOptions: string[] | undefined,
): boolean {
	return (securityOptions ?? []).some((option) =>
		option.split(",").includes("name=rootless"),
	);
}

/**
 * Why swarm mode can't run on the daemon `docker info` describes, or null
 * when it can. A rootless daemon can't create the overlay network a swarm
 * service joins.
 */
export function swarmUnavailableReason(
	securityOptions: string[] | undefined,
): string | null {
	if (!isRootlessDaemon(securityOptions)) {
		return null;
	}
	return "This Docker daemon runs rootless, and rootless Docker can't create the overlay networks swarm services need. Move Homerun onto the system (rootful) daemon first: sudo homerun-installer --migrate-to-rootful.";
}

/**
 * The orchestration mode a brand new instance starts in: swarm when this
 * daemon is already a swarm manager and isn't rootless (what the default
 * installer sets up), standalone otherwise.
 */
export function initialOrchestrationMode(info: {
	SecurityOptions?: string[];
	Swarm?: { ControlAvailable?: boolean; LocalNodeState?: string };
}): "standalone" | "swarm" {
	const manager =
		info.Swarm?.LocalNodeState === "active" &&
		info.Swarm.ControlAvailable === true;
	return manager && swarmUnavailableReason(info.SecurityOptions) === null
		? "swarm"
		: "standalone";
}

/**
 * A service volume as a swarm mount: an absolute source is a bind mount of
 * that host path, anything else is a named volume, the same rule Docker's
 * `Binds` syntax applies to a standalone container.
 */
export function swarmMount(volume: VolumeMountParams): {
	ReadOnly: boolean;
	Source: string;
	Target: string;
	Type: "bind" | "volume";
} {
	return {
		ReadOnly: volume.readOnly,
		Source: volume.source,
		Target: volume.containerPath,
		Type: volume.source.startsWith("/") ? "bind" : "volume",
	};
}

/**
 * The networks a swarm service's tasks attach to: the host's own network
 * stack for host networking, otherwise the shared overlay with the slug as
 * an alias, so other services reach it at `http://<slug>:<port>` the same
 * way they reach a standalone container.
 */
export function swarmNetworksFor(
	networkMode: "bridge" | "host" | undefined,
	overlay: string,
	slug: string,
): { Aliases?: string[]; Target: string }[] {
	if (networkMode === "host") {
		return [{ Target: "host" }];
	}
	return [{ Aliases: [slug], Target: overlay }];
}

/** Swarm's restart conditions for this app's restart policy values: "no" never restarts, "on-failure" only after a non-zero exit, anything else always. */
export function swarmRestartCondition(
	restartPolicy: string,
): "any" | "none" | "on-failure" {
	if (restartPolicy === "no") {
		return "none";
	}
	return restartPolicy === "on-failure" ? "on-failure" : "any";
}

/**
 * The swarm service spec for a service, minus its name and what depends on
 * the image the deploy actually resolved (the task's `Env`, `Image`, readiness
 * `Healthcheck` and label): Traefik and tracking labels on the service (routed
 * over the swarm overlay), the replica count, and a task template with the
 * runtime options, mounts (`swarmMount`), networks (`swarmNetworksFor`),
 * resource limits and restart condition. The homerun worker fills in the rest.
 */
export function swarmServiceTemplate(params: CreateSwarmServiceParams) {
	return {
		Labels: mergeLabels(
			params.runtime?.labels,
			buildContainerLabels({
				authPaths: params.authPaths,
				authPathsMode: params.authPathsMode,
				authRequired: params.authRequired,
				blockedPaths: params.blockedPaths,
				containerPort: params.containerPort,
				defaultDomainEnabled: params.defaultDomainEnabled,
				dnsResolvable:
					params.networkMode === "host" ? false : params.dnsResolvable,
				domainPorts: params.domainPorts,
				domains: params.domains,
				stripPathDomains: params.stripPathDomains,
				errorPages: errorPagesPublished(),
				httpCacheTtl: params.httpCacheTtl,
				networkName: swarmNetworkName(),
				serviceId: params.serviceId,
				slug: params.slug,
				stackSlug: params.stackSlug,
			}),
		),
		EndpointSpec: params.publishedPorts?.length
			? {
					Ports: params.publishedPorts.map((port) => ({
						Protocol: port.protocol,
						PublishedPort: port.hostPort,
						PublishMode: "ingress",
						TargetPort: port.containerPort,
					})),
				}
			: undefined,
		Mode: { Replicated: { Replicas: params.replicas } },
		TaskTemplate: {
			ContainerSpec: {
				Args: params.runtime?.command ?? undefined,
				CapabilityAdd: params.runtime?.capAdd.length
					? params.runtime.capAdd.map(capabilityName)
					: undefined,
				Command: params.runtime?.entrypoint ?? undefined,
				Labels: mergeLabels(params.runtime?.labels, {
					[SERVICE_ID_LABEL]: params.serviceId,
					"homerun.managed": "true",
				}),
				Mounts: (params.volumes ?? []).map(swarmMount),
				User: params.runtime?.runAsUser || undefined,
			},
			Networks: swarmNetworksFor(
				params.networkMode,
				swarmNetworkName(),
				params.slug,
			),
			Resources: {
				Limits: {
					MemoryBytes: params.memoryLimitMb
						? params.memoryLimitMb * 1024 * 1024
						: undefined,
					NanoCPUs: params.cpuLimit
						? Math.round(Number.parseFloat(params.cpuLimit) * 1e9)
						: undefined,
				},
			},
			RestartPolicy: {
				Condition: swarmRestartCondition(params.restartPolicy),
			},
		},
	};
}

interface DaemonInfo {
	SecurityOptions?: string[];
	ServerVersion?: string;
	Swarm?: {
		ControlAvailable?: boolean;
		LocalNodeState?: string;
		NodeID?: string;
	};
}

interface RawSwarmNode {
	Description?: {
		Engine?: { EngineVersion?: string };
		Hostname?: string;
		Platform?: { Architecture?: string; OS?: string };
		Resources?: { MemoryBytes?: number; NanoCPUs?: number };
	};
	ID?: string;
	ManagerStatus?: { Leader?: boolean } | null;
	Spec?: { Availability?: string; Role?: string };
	Status?: { Addr?: string; State?: string };
}

/** One swarm node as the Remote Hosts page lists it. */
export interface SwarmNodeInfo {
	address: string;
	architecture: string;
	availability: string;
	cpus: number;
	engineVersion: string;
	hostname: string;
	id: string;
	leader: boolean;
	memoryBytes: number;
	role: string;
	state: string;
}

/** Flattens the daemon's node inspect into what the page shows. */
export function toSwarmNodeInfo(node: RawSwarmNode): SwarmNodeInfo {
	const description = node.Description ?? {};
	const resources = description.Resources ?? {};
	return {
		address: node.Status?.Addr ?? "",
		architecture: description.Platform?.Architecture ?? "",
		availability: node.Spec?.Availability ?? "",
		cpus: (resources.NanoCPUs ?? 0) / 1e9,
		engineVersion: description.Engine?.EngineVersion ?? "",
		hostname: description.Hostname ?? node.ID ?? "",
		id: node.ID ?? "",
		leader: node.ManagerStatus?.Leader ?? false,
		memoryBytes: resources.MemoryBytes ?? 0,
		role: node.Spec?.Role ?? "",
		state: node.Status?.State ?? "",
	};
}

export interface SwarmTask {
	DesiredState?: string;
	ID?: string;
	NodeID?: string;
	ServiceID?: string;
	Slot?: number;
	Status?: {
		ContainerStatus?: { ContainerID?: string; ExitCode?: number } | null;
		Err?: string;
		Message?: string;
		State?: string;
		Timestamp?: string;
	};
	UpdatedAt?: string | null;
}

export interface SwarmReadiness {
	network: string;
	overlayReady: boolean;
	swarmActive: boolean;
	traefikFound: boolean;
	traefikSwarmProvider: boolean;
}

export interface CreateSwarmServiceParams {
	auth?: RegistryAuth;
	containerPort: number;
	cpuLimit?: string | null;
	defaultDomainEnabled?: boolean;
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
	networkMode?: "bridge" | "host";
	portProtocol?: "tcp" | "udp" | "both";
	publishedPorts?: PublishedPort[];
	healthcheckCommand?: string | null;
	runtime?: ContainerRuntimeParams;
	stackSlug?: string | null;
	replicas: number;
	restartPolicy: string;
	serviceId: string;
	slug: string;
	tag: string;
	volumes?: VolumeMountParams[];
}

/**
 * Docker Swarm equivalent of docker/containers.ts, for services deployed
 * under `instanceSettings.orchestrationMode === "swarm"` : a swarm
 *Service* (replicated, self-healing, scalable) instead of a single
 * container. Deliberately local-only for v1 : this app's Remote Hosts
 * feature (an arbitrary separate Docker daemon) doesn't apply the same way
 * under swarm, a "remote" node has to actually join *this* swarm as a
 * worker and get targeted via placement constraints, not connected to as
 * an independent client. Not built here, flagged as a real gap : swarm-mode
 * services always run against the local swarm manager.
 *
 * The host is prepared by `enableSwarmMode` (core-services.ts) when the
 * orchestration mode is switched on the dashboard : `docker swarm init`
 * through `initSwarm` below, the overlay network, and Traefik's
 * `--providers.swarm` flags on the live container.
 */
// oxlint-disable-next-line max-lines-per-function -- mixin factory: the body is a class definition, not a procedure
export function DockerSwarmMixin<TBase extends Constructor<BaseDockerService>>(
	Base: TBase,
) {
	return class DockerSwarmService extends Base {
		/** Whether this daemon is already a swarm manager. */
		async isSwarmActive(): Promise<boolean> {
			const info = await this.worker.get<DaemonInfo>("/v1/info");
			return info?.Swarm?.LocalNodeState === "active";
		}

		/**
		 * Refuses to go further on a rootless daemon, before anything on the
		 * host has been changed.
		 *
		 * @throws When this daemon runs rootless.
		 */
		async assertSwarmCapableDaemon(): Promise<void> {
			const info = await this.worker.get<DaemonInfo>("/v1/info");
			const reason = swarmUnavailableReason(info?.SecurityOptions);
			if (reason) {
				throw new Error(reason);
			}
		}

		/**
		 * Why swarm mode can't be switched on for this daemon, for the settings
		 * page to show before anyone submits. Null when it can, and also when
		 * the daemon can't be reached, since that isn't a reason to refuse.
		 */
		async swarmModeUnavailableReason(): Promise<string | null> {
			const info = await this.worker
				.get<DaemonInfo>("/v1/info")
				.catch(() => null);
			return info ? swarmUnavailableReason(info.SecurityOptions) : null;
		}

		/**
		 * The mode a fresh instance should start in, from the live daemon (see
		 * `initialOrchestrationMode`). Standalone when the daemon can't be
		 * reached.
		 */
		async detectInitialOrchestrationMode(): Promise<"standalone" | "swarm"> {
			const info = await this.worker
				.get<DaemonInfo>("/v1/info")
				.catch(() => null);
			return info ? initialOrchestrationMode(info) : "standalone";
		}

		/**
		 * `docker swarm init` on this host, idempotent : returns false when
		 * the daemon was already a manager. The one place this app runs a
		 * host-level daemon operation, and it does so only because the
		 * dashboard's own Swarm switch is otherwise a setting that changes
		 * nothing.
		 */
		async initSwarm(): Promise<boolean> {
			const { alreadyActive } = await this.worker.post<{
				alreadyActive: boolean;
			}>("/v1/swarm/init");
			if (alreadyActive) {
				return false;
			}
			logger.info("Swarm initialised on this host");
			return true;
		}

		/**
		 * What swarm mode needs before a service can be deployed under it,
		 * each checked against the live daemon rather than assumed : the
		 * daemon being a swarm manager, the overlay network existing, and
		 * Traefik actually running its swarm provider. Read-only.
		 */
		async swarmReadiness(): Promise<SwarmReadiness> {
			const network = swarmNetworkName();
			const [active, networks] = await Promise.all([
				this.isSwarmActive().catch(() => false),
				this.worker
					.get<{ Name: string }[]>("/v1/networks")
					.catch(() => [] as { Name: string }[]),
			]);
			const traefik = await this.worker
				.get<{ Id: string; Image: string }[]>("/v1/containers", { all: "1" })
				.then((rows) => rows.find((row) => row.Image.startsWith("traefik")))
				.catch(() => undefined);
			const cmd: string[] = traefik
				? await this.worker
						.get<{ Config?: { Cmd?: string[] | null } }>(
							`/v1/containers/${traefik.Id}/inspect`,
						)
						.then((info) => info.Config?.Cmd ?? [])
						.catch(() => [])
				: [];
			return {
				network,
				overlayReady: networks.some((net) => net.Name === network),
				swarmActive: active,
				traefikFound: !!traefik,
				traefikSwarmProvider: cmd.some(
					(arg) =>
						arg.startsWith("--providers.swarm=true") ||
						arg.startsWith("--providers.docker.swarmMode=true"),
				),
			};
		}

		/** Idempotent : swarm networks are cluster-wide, created once and reused by every swarm-mode service. */
		async ensureSwarmNetwork(name: string): Promise<void> {
			await this.worker.post<{ ok: boolean }>("/v1/swarm/overlay", { name });
			logger.info(`Swarm overlay network ready: ${name}`);
		}

		/** The swarm's nodes, managers first. */
		async listSwarmNodes(): Promise<SwarmNodeInfo[]> {
			const nodes = await this.worker.get<RawSwarmNode[]>("/v1/swarm/nodes");
			return nodes
				.map(toSwarmNodeInfo)
				.sort(
					(a, b) =>
						Number(b.role === "manager") - Number(a.role === "manager") ||
						a.hostname.localeCompare(b.hostname),
				);
		}

		/**
		 * Forcibly removes a node from the swarm; its tasks are rescheduled
		 * elsewhere. The node still thinks it's joined until `docker swarm
		 * leave` runs on it.
		 */
		async removeSwarmNode(nodeId: string): Promise<void> {
			await this.worker.delete<{ ok: boolean }>(
				`/v1/swarm/nodes/${encodeURIComponent(nodeId)}`,
			);
			logger.info(`Swarm node removed: ${nodeId}`);
		}

		/**
		 * The worker join token and manager address a new node joins with.
		 *
		 * @throws When this daemon isn't a swarm manager.
		 */
		async swarmJoinInfo(): Promise<{ managerAddress: string; token: string }> {
			return await this.worker.get<{ managerAddress: string; token: string }>(
				"/v1/swarm/join",
			);
		}

		/** Removes a swarm service. One already gone isn't an error. */
		async removeSwarmService(swarmServiceId: string): Promise<void> {
			await this.worker.delete<{ ok: boolean }>(
				`/v1/swarm/services/${swarmServiceId}`,
			);
		}

		/** "Stop"/"start" in swarm terms : scale replicas to 0, or back up to the service's configured count. */
		async scaleSwarmService(
			swarmServiceId: string,
			replicas: number,
		): Promise<void> {
			await this.worker.post<{ ok: boolean }>(
				`/v1/swarm/services/${swarmServiceId}/scale`,
				{ replicas },
			);
		}

		/** "Restart" in swarm terms : a force-update, which recreates every task's container even though the spec is unchanged. */
		async restartSwarmService(swarmServiceId: string): Promise<void> {
			await this.worker.post<{ ok: boolean }>(
				`/v1/swarm/services/${swarmServiceId}/restart`,
			);
		}

		/** Aggregate status across every task of the service, same ContainerStatus vocabulary standalone mode uses. */
		async inspectSwarmServiceStatus(
			swarmServiceId: string,
		): Promise<ContainerStatus> {
			const data = await this.worker.get<{ status: ContainerStatus }>(
				`/v1/swarm/services/${swarmServiceId}/status`,
			);
			return data.status;
		}

		/**
		 * The container id of one running task of the service on this node, for
		 * the Terminal tab's exec and pre-backup commands (swarm has no
		 * service-level exec, only container-level, and this app only reaches
		 * the local daemon). Null when every running replica is on another node.
		 */
		async getRunningTaskContainerId(
			swarmServiceId: string,
		): Promise<string | null> {
			const [tasks, info] = await Promise.all([
				this.worker.get<SwarmTask[]>(
					`/v1/swarm/services/${swarmServiceId}/tasks`,
					{ running: "1" },
				),
				this.worker.get<DaemonInfo>("/v1/info"),
			]);
			const localNodeId = info?.Swarm?.NodeID;
			const running = tasks.find(
				(task) =>
					task.Status?.State === "running" &&
					(!localNodeId || task.NodeID === localNodeId),
			);
			return running?.Status?.ContainerStatus?.ContainerID ?? null;
		}

		/** Same Web ReadableStream shape and options as containers.ts's streamLogs, so a logs route doesn't need to know which mode it's in. The worker demuxes the frames, so what comes back is already plain text. */
		streamSwarmServiceLogs(
			swarmServiceId: string,
			opts?: { tail?: number; follow?: boolean },
		): Promise<ReadableStream<Uint8Array>> {
			return this.worker.stream(`/v1/swarm/services/${swarmServiceId}/logs`, {
				query: {
					follow: opts?.follow === false ? "0" : "1",
					tail: String(opts?.tail ?? 200),
				},
			});
		}
	};
}
