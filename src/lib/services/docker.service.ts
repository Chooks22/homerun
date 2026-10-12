// DockerService : Docker operational surface for container lifecycle,
// networking, Traefik/custom-SSL config, status
// reconciliation, and the interactive terminal. Backs every route/DTO
// that touches a service's container or the shared Traefik/network infra.
//
// Built from real classes, not a bag of re-exported functions : each
// concern (containers, networks, reconcile, custom-ssl,
// core-services/Traefik, terminal) is its own class in services/docker/**,
// extending BaseDockerService, and all of them merge into one class here
// via the TS mixin pattern (each file exports a `SomethingMixin(Base)`
// function). `DockerService` is the single instantiated singleton of that
// merged class, every route/DTO imports this same instance and calls
// real inherited instance methods on it (`DockerService.pullImage(...)`),
// not static delegates to loose functions.

export type { ContainerStatus } from "#lib/types.js";
export type {
	CleanupCategory,
	CleanupItem,
	CleanupPreview,
	PruneSummary,
	SystemPruneSummary,
} from "./docker/cleanup.ts";
export type { RemoteHostConnection } from "./docker/client.ts";
export type {
	CreateContainerParams,
	PullProgressEvent,
	RegistryAuth,
	VolumeMountParams,
} from "./docker/containers.ts";
export type {
	MirrorCopyResult,
	ScanImageParams,
} from "./docker/image-scan.ts";
export type {
	OneOffRunParams,
	OneOffRunResult,
} from "./docker/one-off.ts";
export type { SwarmNodeInfo } from "./docker/swarm.ts";
export type { SwarmReplica } from "./docker/swarm-replicas.ts";

import { BaseDockerService } from "./docker/base.ts";
import { DockerCleanupMixin } from "./docker/cleanup.ts";
import { DockerContainerMixin } from "./docker/containers.ts";
import { DockerCoreServicesMixin } from "./docker/core-services.ts";
import { DockerCustomSslMixin } from "./docker/custom-ssl.ts";
import { DockerGarageMixin } from "./docker/garage.ts";
import { DockerImageScanMixin } from "./docker/image-scan.ts";
import { DockerNetworkMixin } from "./docker/networks.ts";
import { DockerNewtMixin } from "./docker/newt-tunnel.ts";
import { DockerOneOffMixin } from "./docker/one-off.ts";
import { DockerOtelMixin } from "./docker/otel.ts";
import { DockerReconcileMixin } from "./docker/reconcile.ts";
import { DockerRevisionMixin } from "./docker/revisions.ts";
import { DockerSwarmMixin } from "./docker/swarm.ts";
import { DockerSwarmReplicasMixin } from "./docker/swarm-replicas.ts";
import { DockerTerminalMixin } from "./docker/terminal.ts";

// Merge order matters only where one concern calls another's methods via
// `this` : containers before one-off (runOneOff calls this.pullImage), core
// services before the Newt tunnel (it calls this.applyTraefikFlags). The
// rest have no cross-concern dependency, so their position is arbitrary.
class DockerServiceClass extends DockerOtelMixin(
	DockerGarageMixin(
		DockerRevisionMixin(
			DockerImageScanMixin(
				DockerCleanupMixin(
					DockerOneOffMixin(
						DockerTerminalMixin(
							DockerNewtMixin(
								DockerCoreServicesMixin(
									DockerCustomSslMixin(
										DockerReconcileMixin(
											DockerSwarmReplicasMixin(
												DockerSwarmMixin(
													DockerContainerMixin(
														DockerNetworkMixin(BaseDockerService),
													),
												),
											),
										),
									),
								),
							),
						),
					),
				),
			),
		),
	),
) {}

export const DockerService = new DockerServiceClass();
