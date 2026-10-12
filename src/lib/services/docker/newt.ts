import { createHash } from "node:crypto";
import { dockerHealthcheck } from "./healthcheck.ts";

/**
 * A Docker Engine container-create body, as much of it as a core container's
 * spec sets. `name` is carried alongside the rest here and split back out by
 * the caller, since the Engine takes it as a query parameter rather than a
 * body field.
 */
export interface ContainerCreateOptions {
	Env?: string[];
	Healthcheck?: Record<string, unknown>;
	HostConfig?: Record<string, unknown>;
	Image?: string;
	Labels?: Record<string, string>;
	name?: string;
}

/** A swarm service-create body, as much of it as a core service's spec sets. */
export interface SwarmServiceSpec {
	Labels: Record<string, string>;
	Mode: Record<string, unknown>;
	Name: string;
	TaskTemplate: Record<string, unknown>;
}

export interface NewtCredentials {
	endpoint: string;
	id: string;
	secret: string;
}

export interface NewtEndpoint {
	GlobalIPv6Address?: string;
	IPAddress?: string;
}

export const NEWT_CONTAINER_NAME = "homerun-newt";
export const NEWT_IMAGE = "fosrl/newt:latest";
export const CORE_LABEL = "homerun.core";
export const CORE_HASH_LABEL = "homerun.core.hash";
export const NEWT_HEALTHCHECK =
	"wget -qO- http://127.0.0.1:2112/metrics | grep -Eq '^newt_websocket_connected(\\{[^}]*\\})? 1$'";

/** Newt's environment and the hash of everything that shapes a Newt workload on `network` in `mode`, so a sync can tell whether the running one is still current. */
function newtShape(
	credentials: NewtCredentials,
	network: string,
	mode: "container" | { nodeId: string },
): { env: string[]; hash: string } {
	const env = [
		`PANGOLIN_ENDPOINT=${credentials.endpoint}`,
		`NEWT_ID=${credentials.id}`,
		`NEWT_SECRET=${credentials.secret}`,
		"NEWT_METRICS_PROMETHEUS_ENABLED=true",
	];
	const shape = [NEWT_IMAGE, network, NEWT_HEALTHCHECK, env];
	const hash = createHash("sha256")
		.update(JSON.stringify(mode === "container" ? shape : [...shape, mode]))
		.digest("hex");
	return { env, hash };
}

/**
 * The create options for Homerun's own Newt container on `network`, labelled
 * with a hash of everything that shapes it so a sync can tell whether the
 * running container is still the one it would create.
 */
export function newtContainerSpec(
	credentials: NewtCredentials,
	network: string,
): ContainerCreateOptions {
	const { env, hash } = newtShape(credentials, network, "container");
	return {
		Env: env,
		Healthcheck: dockerHealthcheck(NEWT_HEALTHCHECK),
		HostConfig: {
			NetworkMode: network,
			RestartPolicy: { Name: "unless-stopped" },
		},
		Image: NEWT_IMAGE,
		Labels: { [CORE_HASH_LABEL]: hash, [CORE_LABEL]: "newt" },
		name: NEWT_CONTAINER_NAME,
	};
}

/**
 * The Engine spec for Homerun's own Newt tunnel as a one-replica swarm service
 * on the swarm overlay `network`, which Traefik is attached to in swarm mode.
 * Pinned to `nodeId`, the node Traefik runs on, so the tunnel reaches it by
 * name and the local container listing that picks the tunnel target sees
 * the task. Carries the same hash label as the container, on the service, and
 * the core label on its task containers too so `findNewtContainer` still
 * finds them.
 */
export function newtSwarmServiceSpec(
	credentials: NewtCredentials,
	network: string,
	nodeId: string,
): SwarmServiceSpec {
	const { env, hash } = newtShape(credentials, network, { nodeId });
	return {
		Labels: { [CORE_HASH_LABEL]: hash, [CORE_LABEL]: "newt" },
		Mode: { Replicated: { Replicas: 1 } },
		Name: NEWT_CONTAINER_NAME,
		TaskTemplate: {
			ContainerSpec: {
				Env: env,
				HealthCheck: dockerHealthcheck(NEWT_HEALTHCHECK),
				Image: NEWT_IMAGE,
				Labels: { [CORE_LABEL]: "newt" },
			},
			Networks: [{ Target: network }],
			Placement: { Constraints: [`node.id == ${nodeId}`] },
			RestartPolicy: { Condition: "any" },
		},
	};
}

/**
 * The Traefik flag making `entrypoint` trust the `X-Forwarded-For` and
 * `X-Real-Ip` the Newt container in `newt` sends, so a visitor behind
 * Pangolin is seen (and banned) as themselves rather than as the tunnel.
 * Only Newt's own addresses: trusting its whole network would trust Docker's
 * gateway too, which is where docker-proxy hands over published-port traffic
 * from outside, and anyone could then name their own address. Null while
 * Newt has no address yet (a swarm task still starting).
 */
export function tunnelTrustFlags(
	entrypoint: string,
	newt: { NetworkSettings?: { Networks?: Record<string, NewtEndpoint> } },
): Record<string, string> | null {
	const addresses = Object.values(newt.NetworkSettings?.Networks ?? {})
		.flatMap((endpoint) => [endpoint.IPAddress, endpoint.GlobalIPv6Address])
		.filter((address): address is string => Boolean(address));
	return addresses.length > 0
		? {
				[`entryPoints.${entrypoint}.forwardedHeaders.trustedIPs`]:
					addresses.join(","),
			}
		: null;
}
