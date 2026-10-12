import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import type { BaseDockerService, Constructor } from "./base.ts";
import {
	type InfraContainer,
	type InspectedContainer,
	type ListedContainer,
	splitImageRef,
	type TraefikInfo,
	type TraefikUpdateResult,
} from "./core-services.ts";
import {
	CORE_HASH_LABEL,
	CORE_LABEL,
	NEWT_CONTAINER_NAME,
	type NewtCredentials,
	newtContainerSpec,
	newtSwarmServiceSpec,
	tunnelTrustFlags,
} from "./newt.ts";
import { swarmNetworkName } from "./swarm.ts";

const LEADING_SLASH_RE = /^\//;

const logger = new Logger("Traefik");

/** What the Newt tunnel needs from the network, container, swarm and core-services mixins, all merged ahead of it (see docker.service.ts). */
interface RequiresNewtDeps {
	applyTraefikFlags: (
		flags: Record<string, string | null>,
	) => Promise<TraefikUpdateResult>;
	ensureSharedNetwork: () => Promise<void>;
	ensureSwarmNetwork: (name: string) => Promise<void>;
	findTraefikContainer: () => Promise<TraefikInfo | null>;
	pullImage: (params: { image: string; tag: string }) => Promise<unknown>;
	removeSwarmService: (swarmServiceId: string) => Promise<void>;
}

/** A swarm service inspect, as much of it as the Newt sync reads. */
interface InspectedSwarmService {
	ID: string;
	Spec: { Labels?: Record<string, string> };
}

/** Homerun's own Pangolin tunnel client (Newt): a core container or swarm service, and the Traefik trust that lets visitors through it be seen as themselves. Requires the core-services mixin ahead of it. */
// oxlint-disable-next-line max-lines-per-function -- mixin factory: the body is a class definition, not a procedure
export function DockerNewtMixin<
	TBase extends Constructor<BaseDockerService & RequiresNewtDeps>,
>(Base: TBase) {
	return class DockerNewtService extends Base {
		/**
		 * Whether a Pangolin tunnel client is already running on this host, so
		 * the Pangolin settings can say "the tunnel is up" rather than leaving
		 * the operator to guess why Resources resolve but nothing answers.
		 * Matched on the image name, same shape as findTraefikContainer.
		 */
		async findNewtContainer(): Promise<InfraContainer | null> {
			const containers = await this.worker.get<ListedContainer[]>(
				"/v1/containers",
				{ all: "1" },
			);
			const match =
				containers.find(
					(container) => container.Labels?.[CORE_LABEL] === "newt",
				) ?? containers.find((container) => container.Image.includes("newt"));
			if (!match) {
				return null;
			}
			return {
				id: match.Id,
				image: match.Image,
				name:
					match.Names[0]?.replace(LEADING_SLASH_RE, "") ??
					match.Id.slice(0, 12),
				project: match.Labels?.["com.docker.compose.project"] ?? "",
				service:
					match.Labels?.["com.docker.compose.service"] ??
					match.Labels?.[CORE_LABEL] ??
					"",
				state: match.State,
			};
		}

		/**
		 * Converges Homerun's own Newt tunnel onto `credentials`: a plain
		 * container on the shared network in standalone mode, a one-replica
		 * swarm service on the swarm overlay in swarm mode, removing whichever
		 * of the two the current mode doesn't use first. Each is left alone
		 * when it was created from the same spec and recreated otherwise;
		 * null credentials remove both. It's core infrastructure, never a
		 * service, so it carries the core label rather than the managed one.
		 * Failures are logged, not thrown.
		 */
		async syncNewt(
			credentials: NewtCredentials | null,
			swarm: boolean,
		): Promise<void> {
			try {
				if (swarm) {
					await this.#convergeNewtContainer(null);
					await this.#convergeNewtService(credentials);
				} else {
					await this.#convergeNewtService(null);
					await this.#convergeNewtContainer(credentials);
				}
				if (credentials) {
					await this.#trustNewt();
				}
			} catch (err) {
				logger.warn("Couldn't sync the Newt tunnel", err);
			}
		}

		/** Points Traefik's forwarded-header trust at the running Newt's current addresses (`tunnelTrustFlags`). Throws on any Docker failure. */
		async #trustNewt(): Promise<void> {
			const newt = await this.findNewtContainer();
			if (!(newt && (await this.findTraefikContainer()))) {
				return;
			}
			const flags = tunnelTrustFlags(
				config.traefik.entrypoint,
				await this.worker.get<InspectedContainer>(
					`/v1/containers/${newt.id}/inspect`,
				),
			);
			if (flags) {
				await this.applyTraefikFlags(flags);
			}
		}

		/** Converges the swarm-mode Newt service, removing it for null credentials. Throws on any Docker failure. */
		async #convergeNewtService(
			credentials: NewtCredentials | null,
		): Promise<void> {
			const existing = await this.worker
				.get<InspectedSwarmService>(`/v1/swarm/services/${NEWT_CONTAINER_NAME}`)
				.catch(() => null);

			if (!credentials) {
				if (existing) {
					await this.removeSwarmService(existing.ID);
					logger.info("Newt swarm service removed");
				}
				return;
			}

			const network = swarmNetworkName();
			await this.ensureSwarmNetwork(network);
			const info = await this.worker.get<{ Swarm?: { NodeID?: string } }>(
				"/v1/info",
			);
			const nodeId = info.Swarm?.NodeID;
			if (!nodeId) {
				throw new Error("This host isn't a swarm node.");
			}
			const spec = newtSwarmServiceSpec(credentials, network, nodeId);
			if (
				existing?.Spec.Labels?.[CORE_HASH_LABEL] ===
				spec.Labels[CORE_HASH_LABEL]
			) {
				return;
			}
			if (existing) {
				await this.removeSwarmService(existing.ID);
			}
			await this.worker.post("/v1/swarm/services", spec);
			logger.info("Newt swarm service created");
		}

		/** Converges the standalone Newt container, removing it for null credentials. Throws on any Docker failure. */
		async #convergeNewtContainer(
			credentials: NewtCredentials | null,
		): Promise<void> {
			const existing = await this.worker
				.get<InspectedContainer>(
					`/v1/containers/${NEWT_CONTAINER_NAME}/inspect`,
				)
				.catch(() => null);

			if (!credentials) {
				if (existing) {
					await this.worker.delete(`/v1/containers/${existing.Id}`, {
						force: "1",
					});
					logger.info("Newt container removed");
				}
				return;
			}

			await this.ensureSharedNetwork();
			const spec = newtContainerSpec(credentials, config.docker.networkName);
			if (
				existing &&
				existing.Config.Labels?.[CORE_HASH_LABEL] ===
					spec.Labels?.[CORE_HASH_LABEL]
			) {
				if (!existing.State.Running) {
					await this.worker.post(`/v1/containers/${NEWT_CONTAINER_NAME}/start`);
					logger.info("Newt container started");
				}
				return;
			}

			await this.pullImage(splitImageRef(spec.Image ?? ""));
			if (existing) {
				await this.worker.delete(`/v1/containers/${existing.Id}`, {
					force: "1",
				});
			}
			const { name, ...body } = spec;
			const created = await this.worker.post<{ id: string }>("/v1/containers", {
				body,
				name,
			});
			await this.worker.post(`/v1/containers/${created.id}/start`);
			logger.info("Newt container created");
		}
	};
}
