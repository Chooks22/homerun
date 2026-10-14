import {
	defaultHostname,
	isDomainEntry,
	normalizeDomains,
	serviceHostnames,
	splitDomain,
} from "#lib/service-domains.js";
import { parseCronSchedule } from "#lib/services/cron/cron-expression.js";

export interface RoutingFields {
	containerPort: number;
	defaultDomainEnabled: boolean;
	domainPorts: Record<string, number>;
	domains: string[];
	primaryDomain: string | null;
	slug: string;
	stripPathDomains: string[];
}

export interface RoutingPatch {
	defaultDomainEnabled: boolean;
	domainPorts: Record<string, number>;
	domains: string[];
	primaryDomain: string | null;
	stripPathDomains: string[];
}

/**
 * A service's routed domains after an update: `input`'s fields over
 * `current`'s, the default hostname dropped from the custom list, a port
 * kept only for a listed domain that isn't the container port, path
 * stripping kept only for a listed domain with a path, and the main domain
 * kept only while it's routed. Null when the update touches none of
 * them.
 *
 * @returns The new routing columns and every hostname they route, or why
 *   they can't be saved: a malformed domain, or no hostname left at all.
 */
export function routingPatch(
	current: RoutingFields,
	input: Partial<RoutingFields>,
	context: { baseDomain: string; stackSlug: string | null | undefined },
): { error: string } | { hostnames: string[]; patch: RoutingPatch } | null {
	if (
		input.domains === undefined &&
		input.defaultDomainEnabled === undefined &&
		input.primaryDomain === undefined &&
		input.domainPorts === undefined &&
		input.stripPathDomains === undefined
	) {
		return null;
	}
	const merged = {
		...current,
		...Object.fromEntries(
			Object.entries(input).filter(([, value]) => value !== undefined),
		),
	} as RoutingFields;
	const fallback = defaultHostname(
		merged.slug,
		context.stackSlug,
		context.baseDomain,
	);
	const domains = normalizeDomains(merged.domains).filter(
		(domain) => domain !== fallback,
	);
	const invalid = domains.find((domain) => !isDomainEntry(domain));
	if (invalid) {
		return { error: `"${invalid}" isn't a valid domain.` };
	}
	const hostnames = serviceHostnames(
		{
			defaultDomainEnabled: merged.defaultDomainEnabled,
			domains,
			primaryDomain: null,
			slug: merged.slug,
		},
		context.stackSlug,
		context.baseDomain,
	);
	if (hostnames.length === 0) {
		return {
			error:
				"Keep at least one domain, or turn public routing off in the Network section.",
		};
	}
	const domainPorts = Object.fromEntries(
		Object.entries(merged.domainPorts).filter(
			([domain, port]) =>
				domains.includes(domain) && port !== merged.containerPort,
		),
	);
	const stripPathDomains = normalizeDomains(merged.stripPathDomains).filter(
		(domain) => domains.includes(domain) && splitDomain(domain).path !== "",
	);
	const chosen = merged.primaryDomain?.trim().toLowerCase() ?? "";
	return {
		hostnames,
		patch: {
			defaultDomainEnabled: merged.defaultDomainEnabled,
			domainPorts,
			domains,
			primaryDomain: hostnames.includes(chosen)
				? chosen
				: (hostnames[0] ?? null),
			stripPathDomains,
		},
	};
}

/**
 * What a custom certificate update does: `clear` when both halves are null,
 * `set` when both are given, nothing when neither is sent.
 *
 * @returns The change, or why it can't be made (only one half sent).
 */
export function customSslChange(input: {
	customSslCert?: string | null;
	customSslKey?: string | null;
}):
	| { error: string }
	| { cert: string; key: string; kind: "set" }
	| { kind: "clear" }
	| null {
	const { customSslCert: cert, customSslKey: key } = input;
	if (cert === undefined && key === undefined) {
		return null;
	}
	if (cert === null && key === null) {
		return { kind: "clear" };
	}
	if (cert && key) {
		return { cert, key, kind: "set" };
	}
	return { error: "Send both the certificate and its private key." };
}

/**
 * Why a save would leave scheduled redeploys on without a valid schedule, or
 * null when it wouldn't. A schedule sent as null or blank counts as cleared,
 * not as "keep the stored one".
 */
export function cronScheduleProblem(
	current: { cronEnabled: boolean; cronSchedule: string | null },
	input: { cronEnabled?: boolean; cronSchedule?: string | null },
): string | null {
	if (input.cronEnabled === undefined && input.cronSchedule === undefined) {
		return null;
	}
	const enabled = input.cronEnabled ?? current.cronEnabled;
	const schedule =
		(input.cronSchedule === undefined
			? current.cronSchedule
			: input.cronSchedule) ?? "";
	return enabled && !parseCronSchedule(schedule)
		? 'Invalid schedule : use standard 5-field cron syntax (e.g. "0 3 * * *").'
		: null;
}
