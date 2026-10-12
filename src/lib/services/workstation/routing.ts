import { stringify } from "yaml";
import { config } from "#lib/config.js";
import { certResolverFor } from "#lib/services/docker/cert-resolver.js";

/** The Traefik router and service name of a workstation, kept apart from service routers named after their slug. */
export function workstationRouter(slug: string): string {
	return `workstation-${slug}`;
}

/** The dynamic config file an agent-hosted workstation's route lives in. */
export function workstationRouteFile(slug: string): string {
	return `homerun-workstation-${slug}.yml`;
}

/** The certificate resolver for `host`, null when Traefik shouldn't request one. */
function resolverFor(host: string): string | null {
	return certResolverFor(
		host,
		config.traefik.certResolver,
		config.pangolinEnabled,
		config.traefik.instanceCertNames,
	);
}

/**
 * The Docker-provider labels routing `host` to a workstation on this server's
 * Docker network, at its container `port`.
 */
export function workstationLabels(
	slug: string,
	host: string,
	port: number,
): Record<string, string> {
	const name = workstationRouter(slug);
	const labels: Record<string, string> = {
		"traefik.docker.network": config.docker.networkName,
		"traefik.enable": "true",
		[`traefik.http.routers.${name}.entrypoints`]: config.traefik.entrypoint,
		[`traefik.http.routers.${name}.rule`]: `Host(\`${host}\`)`,
		[`traefik.http.routers.${name}.service`]: name,
		[`traefik.http.routers.${name}.tls`]: "true",
		[`traefik.http.services.${name}.loadbalancer.server.port`]: String(port),
	};
	const resolver = resolverFor(host);
	if (resolver) {
		labels[`traefik.http.routers.${name}.tls.certresolver`] = resolver;
	}
	return labels;
}

/**
 * The file-provider config routing `host` to a workstation published on an
 * agent host, at `upstream` (`http://<agent host>:<port>`).
 */
export function workstationRouteYaml(
	slug: string,
	host: string,
	upstream: string,
): string {
	const name = workstationRouter(slug);
	const resolver = resolverFor(host);
	return stringify({
		http: {
			routers: {
				[name]: {
					entryPoints: [config.traefik.entrypoint],
					rule: `Host(\`${host}\`)`,
					service: name,
					tls: resolver ? { certResolver: resolver } : {},
				},
			},
			services: {
				[name]: { loadBalancer: { servers: [{ url: upstream }] } },
			},
		},
	});
}

/** The hostname part of an agent's base URL, which is where its published ports are reachable too. */
export function agentHostAddress(agentUrl: string): string {
	return new URL(agentUrl).hostname;
}
