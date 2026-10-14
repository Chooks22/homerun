import { stringify } from "yaml";
import { config } from "#lib/config.js";
import { certResolverFor } from "#lib/services/docker/cert-resolver.js";

/** The Traefik router and service name of a workstation, kept apart from service routers named after their slug. */
export function workstationRouter(slug: string): string {
	return `workstation-${slug}`;
}

/** The forwardAuth address that signs a workstation's visitors in through git. */
export function workstationAuthCheckUrl(workstationId: string): string {
	const separator = config.authCheckUrl.includes("?") ? "&" : "?";
	return `${config.authCheckUrl}${separator}workstation=${encodeURIComponent(workstationId)}`;
}

/** The forwardAuth middleware name of a workstation's git sign-in. */
function authMiddleware(slug: string): string {
	return `${workstationRouter(slug)}-auth`;
}

/** The dynamic config file a remote-hosted workstation's route lives in. */
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
 * Docker network, at its container `port`, behind the git sign-in's
 * forwardAuth when `authCheckUrl` is given.
 */
export function workstationLabels(
	slug: string,
	host: string,
	port: number,
	authCheckUrl: string | null = null,
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
	if (authCheckUrl) {
		const auth = authMiddleware(slug);
		labels[`traefik.http.middlewares.${auth}.forwardauth.address`] =
			authCheckUrl;
		labels[`traefik.http.routers.${name}.middlewares`] = auth;
	}
	return labels;
}

/**
 * The file-provider config routing `host` to a workstation published on a
 * remote host, at `upstream` (`http://<remote host>:<port>`), behind the git
 * sign-in's forwardAuth when `authCheckUrl` is given.
 */
export function workstationRouteYaml(
	slug: string,
	host: string,
	upstream: string,
	authCheckUrl: string | null = null,
): string {
	const name = workstationRouter(slug);
	const auth = authMiddleware(slug);
	const resolver = resolverFor(host);
	return stringify({
		http: {
			...(authCheckUrl
				? {
						middlewares: { [auth]: { forwardAuth: { address: authCheckUrl } } },
					}
				: {}),
			routers: {
				[name]: {
					entryPoints: [config.traefik.entrypoint],
					...(authCheckUrl ? { middlewares: [auth] } : {}),
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

/** The hostname part of a remote host's agent URL or `tcp://`/`ssh://` Docker address, which is where its published ports are reachable too. */
export function remoteHostAddress(address: string): string {
	return new URL(address).hostname;
}
