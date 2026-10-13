import { config } from "#lib/config.js";
import { type AuthPathsMode, pathPatternsRegex } from "#lib/path-patterns.js";
import { GATE_CALLBACK_PATH, GATE_LOGOUT_PATH } from "#lib/server/app-gate.js";
import { serviceHostnames } from "#lib/service-domains.js";
import { certResolverFor } from "./cert-resolver.ts";
import {
	BLOCKED_PAGE_MIDDLEWARE,
	ERROR_PAGES_MIDDLEWARE,
	ERROR_PAGES_SERVICE,
} from "./error-pages.ts";

export const GATE_IDENTITY_HEADERS = [
	"X-Homerun-User",
	"X-Homerun-Email",
	"X-Homerun-Name",
];

/** The forwardAuth address Traefik should call to gate a service's router, `config.authCheckUrl` with `service` appended as a query param. */
export function authCheckUrlFor(serviceId: string): string {
	const separator = config.authCheckUrl.includes("?") ? "&" : "?";
	return `${config.authCheckUrl}${separator}service=${encodeURIComponent(serviceId)}`;
}

/**
 * Every container this app creates is tagged with these two labels.
 * `listManagedContainers()` (see service.ts) always filters on
 * MANAGED_LABEL : this app must never list, inspect, or touch a
 * container on the host that it didn't create itself.
 */
export function hasTraefikRouterFor(
	labels: Record<string, string>,
	host: string,
): boolean {
	if (labels["traefik.enable"] !== "true") {
		return false;
	}
	return Object.entries(labels).some(
		([key, value]) =>
			key.startsWith("traefik.http.routers.") &&
			key.endsWith(".rule") &&
			value.includes(host),
	);
}

export const RETRY_ATTEMPTS = 4;
export const RETRY_INITIAL_INTERVAL = "100ms";

export const BLOCKED_ROUTER_PRIORITY = 9300;
export const GATE_ROUTER_PRIORITY = 9200;
export const AUTH_PATHS_ROUTER_PRIORITY = 9100;

export const MANAGED_LABEL = "homerun.managed";
export const SERVICE_ID_LABEL = "homerun.service.id";

/**
 * Builds the full label set for a container/swarm service : always the
 * `homerun.managed`/`homerun.service.id` tracking labels, plus (when
 * `dnsResolvable`) one Traefik router per routed hostname (the default
 * `<slug>.<baseDomain>` unless it was turned off, then each of `domains`), each
 * pointing at a Traefik service for its port (`<slug>` for `containerPort`,
 * `<slug>-<port>` for a domain `domainPorts` sends elsewhere), and, only when
 * `authRequired`, the login wall's forwardAuth middleware on every router: an
 * ungated service never calls back into Homerun, so it costs the dashboard
 * nothing per request and keeps serving while Homerun is down. Turning the
 * wall on or off therefore needs a redeploy, which saving it queues. A retry
 * middleware follows, so a
 * request that reaches a container or swarm task that just went away during a
 * rollout is sent to another one; Traefik only retries when no request bytes
 * reached the backend. With `httpCacheTtl` set and the instance's HTTP cache
 * plugin loaded, a Souin cache middleware follows both, keyed on the Cookie
 * and Authorization headers so one session's pages are never served to
 * another. Right before it, `If-None-Match` and `If-Modified-Since` are
 * dropped from the request: Souin answers a matching one from cache with a 304
 * that keeps the stored `Content-Length` but sends no body, which resets the
 * HTTP/2 stream (Chrome's ERR_HTTP2_PROTOCOL_ERROR) and empties the HTTP/1.1
 * reply, so a revalidating browser gets the full cached 200 instead. With `errorPages`, the instance's error pages middleware comes
 * first, so a 502, 503 or 504 shows the branded page instead of Traefik's.
 *
 * Each hostname also gets a `_blocked` router for `blockedPaths`, above
 * every other one, answering 403 through the blocked page (`errorPages`) or
 * a deny-everyone allowlist (without it). A gated service whose
 * `authPathsMode` isn't `all` gets its wall split: a `_paths` router for the
 * `authPaths` that carries the forwardAuth middleware (`only`) or is the one
 * without it (`except`), and a `_gate` router keeping the wall's callback
 * and logout paths behind forwardAuth whatever the patterns say. Every
 * router of such a service that skips forwardAuth blanks the identity
 * headers, so a visitor can't hand the app a forged `X-Homerun-User`. The
 * `_` in these names never appears in a slug, so they can't collide with
 * another service's routers.
 */
export function buildContainerLabels(params: {
	authPaths?: string[];
	authPathsMode?: AuthPathsMode;
	authRequired?: boolean;
	blockedPaths?: string[];
	errorPages?: boolean;
	containerPort: number;
	defaultDomainEnabled?: boolean;
	domainPorts?: Record<string, number>;
	httpCacheTtl?: number | null;
	dnsResolvable?: boolean;
	domains?: string[];
	networkName?: string;
	serviceId: string;
	slug: string;
	stackSlug?: string | null;
}): Record<string, string> {
	const {
		serviceId,
		slug,
		containerPort,
		dnsResolvable = true,
		networkName = config.docker.networkName,
	} = params;

	const baseLabels = {
		[MANAGED_LABEL]: "true",
		[SERVICE_ID_LABEL]: serviceId,
	};

	const hostnames = serviceHostnames(
		{
			defaultDomainEnabled: params.defaultDomainEnabled ?? true,
			domains: params.domains ?? [],
			primaryDomain: null,
			slug,
		},
		params.stackSlug,
		config.baseDomain,
	);
	if (!dnsResolvable || hostnames.length === 0) {
		return baseLabels;
	}

	const authMiddleware = `${slug}-auth`;
	const retryMiddleware = `${slug}-retry`;
	const cacheMiddleware = `${slug}-cache`;
	const unconditionalMiddleware = `${slug}_unconditional`;
	const cached = Boolean(params.httpCacheTtl && config.traefik.httpCache);
	const gated = params.authRequired === true;
	const splitMode =
		gated && params.authPathsMode !== "all" && params.authPaths?.length
			? params.authPathsMode
			: null;
	const stripMiddleware = `${slug}_strip-identity`;
	const chain = (withAuth: boolean) =>
		[
			...(params.errorPages ? [ERROR_PAGES_MIDDLEWARE] : []),
			...(withAuth ? [authMiddleware] : []),
			...(splitMode && !withAuth ? [stripMiddleware] : []),
			retryMiddleware,
			...(cached ? [unconditionalMiddleware, cacheMiddleware] : []),
		].join(",");
	const denyMiddleware = `${slug}_deny`;
	const blocked = params.blockedPaths?.length
		? pathPatternsRegex(params.blockedPaths)
		: null;
	const labels: Record<string, string> = {
		...baseLabels,
		"traefik.docker.network": networkName,
		"traefik.enable": "true",
		[`traefik.http.services.${slug}.loadbalancer.server.port`]:
			String(containerPort),
		[`traefik.http.middlewares.${retryMiddleware}.retry.attempts`]:
			String(RETRY_ATTEMPTS),
		[`traefik.http.middlewares.${retryMiddleware}.retry.initialinterval`]:
			RETRY_INITIAL_INTERVAL,
	};
	if (gated) {
		labels[`traefik.http.middlewares.${authMiddleware}.forwardauth.address`] =
			authCheckUrlFor(serviceId);
		labels[
			`traefik.http.middlewares.${authMiddleware}.forwardauth.authResponseHeaders`
		] = GATE_IDENTITY_HEADERS.join(",");
	}
	if (splitMode) {
		for (const header of GATE_IDENTITY_HEADERS) {
			labels[
				`traefik.http.middlewares.${stripMiddleware}.headers.customrequestheaders.${header}`
			] = "";
		}
	}
	if (blocked && !params.errorPages) {
		labels[
			`traefik.http.middlewares.${denyMiddleware}.ipallowlist.sourcerange`
		] = "127.0.0.1/32";
	}
	if (cached) {
		const souin = `traefik.http.middlewares.${cacheMiddleware}.plugin.souin`;
		labels[`${souin}.default_cache.ttl`] = `${params.httpCacheTtl}s`;
		labels[`${souin}.default_cache.key.headers[0]`] = "Cookie";
		labels[`${souin}.default_cache.key.headers[1]`] = "Authorization";
		for (const header of ["If-None-Match", "If-Modified-Since"]) {
			labels[
				`traefik.http.middlewares.${unconditionalMiddleware}.headers.customrequestheaders.${header}`
			] = "";
		}
	}

	hostnames.forEach((hostname, index) => {
		const router = index === 0 ? slug : `${slug}-${index}`;
		const host = `Host(\`${hostname}\`)`;
		const port = params.domainPorts?.[hostname] ?? containerPort;
		const service = port === containerPort ? slug : `${slug}-${port}`;
		labels[`traefik.http.services.${service}.loadbalancer.server.port`] =
			String(port);
		const resolver = certResolverFor(
			hostname,
			config.traefik.certResolver,
			config.pangolinEnabled,
			config.traefik.instanceCertNames,
		);
		const route = ({
			middlewares,
			name,
			priority,
			rule,
			target,
		}: {
			middlewares: string;
			name: string;
			priority?: number;
			rule: string;
			target: string;
		}) => {
			labels[`traefik.http.routers.${name}.rule`] = rule;
			labels[`traefik.http.routers.${name}.entrypoints`] =
				config.traefik.entrypoint;
			labels[`traefik.http.routers.${name}.tls`] = "true";
			labels[`traefik.http.routers.${name}.service`] = target;
			labels[`traefik.http.routers.${name}.middlewares`] = middlewares;
			if (priority) {
				labels[`traefik.http.routers.${name}.priority`] = String(priority);
			}
			if (resolver) {
				labels[`traefik.http.routers.${name}.tls.certresolver`] = resolver;
			}
		};

		route({
			middlewares: chain(gated && splitMode !== "only"),
			name: router,
			rule: host,
			target: service,
		});
		if (splitMode && params.authPaths) {
			route({
				middlewares: chain(splitMode === "only"),
				name: `${router}_paths`,
				priority: AUTH_PATHS_ROUTER_PRIORITY,
				rule: `${host} && PathRegexp(\`${pathPatternsRegex(params.authPaths)}\`)`,
				target: service,
			});
			route({
				middlewares: chain(true),
				name: `${router}_gate`,
				priority: GATE_ROUTER_PRIORITY,
				rule: `${host} && (Path(\`${GATE_CALLBACK_PATH}\`) || Path(\`${GATE_LOGOUT_PATH}\`))`,
				target: service,
			});
		}
		if (blocked) {
			route({
				middlewares: params.errorPages
					? BLOCKED_PAGE_MIDDLEWARE
					: denyMiddleware,
				name: `${router}_blocked`,
				priority: BLOCKED_ROUTER_PRIORITY,
				rule: `${host} && PathRegexp(\`${blocked}\`)`,
				target: params.errorPages ? ERROR_PAGES_SERVICE : service,
			});
		}
	});

	return labels;
}

/**
 * Whether a running workload's login-wall routing no longer matches what a
 * deploy would give it today: a forwardAuth middleware on a service whose
 * wall is off (left by a deploy from before ungated services stopped getting
 * one), none on a gated service, or one pointing at an old check URL (the
 * dashboard's container name before the `homerun-auth` alias).
 */
export function loginWallDrifted(
	labels: Record<string, string>,
	expectedAddress: string | null,
): boolean {
	const addresses = Object.entries(labels)
		.filter(([key]) => key.endsWith(".forwardauth.address"))
		.map(([, value]) => value);
	if (expectedAddress === null) {
		return addresses.length > 0;
	}
	return (
		addresses.length === 0 ||
		addresses.some((address) => address !== expectedAddress)
	);
}
