import { createHmac } from "node:crypto";
import { stringify } from "yaml";

export const ACME_DNS_PATH = "/api/acme-dns";
export const ACME_DNS_USERNAME = "homerun";
export const ACME_WILDCARD_ROUTER_FILE = "homerun-acme-wildcards.yml";

const PUBLIC_RESOLVERS = "1.1.1.1:53,8.8.8.8:53";
const DEFAULT_STORAGE = "/letsencrypt/acme.json";
const PROPAGATION_TIMEOUT_SECONDS = "600";
const POLLING_INTERVAL_SECONDS = "10";
const HTTP_TIMEOUT_SECONDS = "120";
const DNS_CHALLENGE_FLAGS = [
	"dnschallenge.provider",
	"dnschallenge.resolvers",
	"email",
	"storage",
];
const HTTPREQ_VARIABLES = [
	"HTTPREQ_ENDPOINT",
	"HTTPREQ_HTTP_TIMEOUT",
	"HTTPREQ_PASSWORD",
	"HTTPREQ_POLLING_INTERVAL",
	"HTTPREQ_PROPAGATION_TIMEOUT",
	"HTTPREQ_USERNAME",
];

export interface DnsChallengeSetup {
	endpoint: string;
	password: string;
	username: string;
}

export const DNS_CHALLENGE_RESOLVER = "letsencrypt-dns";

/** The Basic auth password Traefik's httpreq provider presents, derived from the auth secret so nothing new is stored. */
export function acmeDnsPassword(secret: string): string {
	return createHmac("sha256", secret)
		.update("homerun-acme-dns-challenge")
		.digest("hex");
}

/**
 * What Traefik needs to solve DNS-01 challenges through this app: the
 * endpoint at the origin Traefik already reaches it on for forwardAuth
 * (`authCheckUrl`), and the credentials it sends. Null when that URL doesn't
 * parse.
 */
export function dnsChallengeSetup(
	authCheckUrl: string,
	secret: string,
): DnsChallengeSetup | null {
	try {
		return {
			endpoint: `${new URL(authCheckUrl).origin}${ACME_DNS_PATH}`,
			password: acmeDnsPassword(secret),
			username: ACME_DNS_USERNAME,
		};
	} catch {
		return null;
	}
}

/** The bare, lowercased hostname of a challenge record's FQDN (`_acme-challenge.example.com.`). */
export function challengeHostname(fqdn: string): string {
	return fqdn.trim().toLowerCase().replace(/\.$/, "");
}

/** The most specific of `domains` that `host` is or falls under, null when none. */
export function challengeDomainFor(
	host: string,
	domains: string[],
): string | null {
	const target = challengeHostname(host);
	return (
		domains
			.filter((domain) => target === domain || target.endsWith(`.${domain}`))
			.sort((a, b) => b.length - a.length)[0] ?? null
	);
}

/**
 * The names a DNS-challenge domain's one certificate covers: the domain, its
 * first-level subdomains and, when the services subdomain sits below it,
 * that subdomain's too, so every default service hostname shares it.
 */
export function wildcardNames(domain: string, serviceDomain: string): string[] {
	const names = [domain, `*.${domain}`];
	if (serviceDomain !== domain && serviceDomain.endsWith(`.${domain}`)) {
		names.push(`*.${serviceDomain}`);
	}
	return names;
}

/** The value of `--key=value` in a Traefik command line, matched case-insensitively. */
function flagValue(cmd: string[], key: string): string | null {
	const prefix = `--${key.toLowerCase()}=`;
	const arg = cmd.find((candidate) =>
		candidate.toLowerCase().startsWith(prefix),
	);
	return arg ? arg.slice(prefix.length) : null;
}

/**
 * The Traefik flags declaring the DNS-01 resolver, through lego's httpreq
 * provider, sharing the HTTP-01 resolver's storage file and account email
 * (read off the running command, `acmeEmail` winning when set), or every one
 * of them nulled so `applyFlags` removes it when `enabled` is false.
 */
export function dnsChallengeFlags(
	httpResolver: string,
	enabled: boolean,
	cmd: string[],
	acmeEmail: string | null,
): Record<string, string | null> {
	const prefix = `certificatesresolvers.${DNS_CHALLENGE_RESOLVER}.acme`;
	if (!enabled) {
		return Object.fromEntries(
			DNS_CHALLENGE_FLAGS.map((flag) => [`${prefix}.${flag}`, null]),
		);
	}
	const http = `certificatesresolvers.${httpResolver}.acme`;
	const storage = flagValue(cmd, `${http}.storage`) ?? DEFAULT_STORAGE;
	const email = acmeEmail ?? flagValue(cmd, `${http}.email`);
	return {
		[`${prefix}.dnschallenge.provider`]: "httpreq",
		[`${prefix}.dnschallenge.resolvers`]: PUBLIC_RESOLVERS,
		[`${prefix}.email`]: email,
		[`${prefix}.storage`]: storage,
	};
}

/** The environment lego's httpreq provider reads inside Traefik, every variable nulled without a setup. */
export function httpreqEnv(
	setup: DnsChallengeSetup | null,
): Record<string, string | null> {
	if (!setup) {
		return Object.fromEntries(HTTPREQ_VARIABLES.map((name) => [name, null]));
	}
	return {
		HTTPREQ_ENDPOINT: setup.endpoint,
		HTTPREQ_HTTP_TIMEOUT: HTTP_TIMEOUT_SECONDS,
		HTTPREQ_PASSWORD: setup.password,
		HTTPREQ_POLLING_INTERVAL: POLLING_INTERVAL_SECONDS,
		HTTPREQ_PROPAGATION_TIMEOUT: PROPAGATION_TIMEOUT_SECONDS,
		HTTPREQ_USERNAME: setup.username,
	};
}

/** A container's `KEY=value` environment with `changes` set, a null removing its variable; order kept, new ones appended. */
export function applyEnv(
	env: string[],
	changes: Record<string, string | null>,
): string[] {
	const keyOf = (entry: string) => entry.split("=")[0] ?? "";
	const next = env
		.filter((entry) => changes[keyOf(entry)] !== null)
		.map((entry) => {
			const value = changes[keyOf(entry)];
			return value === undefined ? entry : `${keyOf(entry)}=${value}`;
		});
	for (const [key, value] of Object.entries(changes)) {
		if (value !== null && !env.some((entry) => keyOf(entry) === key)) {
			next.push(`${key}=${value}`);
		}
	}
	return next;
}

/**
 * The Traefik dynamic config that makes the DNS-01 resolver issue one
 * wildcard certificate per DNS-challenge domain: a router per domain on a
 * hostname nothing serves, whose `tls.domains` asks for the certificate.
 * Every other router under the domain then carries `tls` with no resolver
 * and gets it from Traefik's store. Null with no domain.
 */
export function acmeWildcardRouterConfig(params: {
	domains: string[];
	entrypoint: string;
	serviceDomain: string;
}): string | null {
	if (params.domains.length === 0) {
		return null;
	}
	const routers = Object.fromEntries(
		params.domains.map((domain) => {
			const [main, ...sans] = wildcardNames(domain, params.serviceDomain);
			return [
				`homerun-acme-wildcard-${domain.replaceAll(".", "-")}`,
				{
					entryPoints: [params.entrypoint],
					rule: `Host(\`_acme-wildcard.${domain}\`)`,
					service: "noop@internal",
					tls: {
						certResolver: DNS_CHALLENGE_RESOLVER,
						domains: [{ main, sans }],
					},
				},
			];
		}),
	);
	return stringify({ http: { routers } });
}
