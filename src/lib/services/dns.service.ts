import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import { serviceRoutedHosts } from "#lib/server/hostname-owner.js";
import { defaultHostname, domainHosts } from "#lib/service-domains.js";
import type { DnsSyncResult } from "./dns-result.ts";
import { dashboardHostFrom } from "./docker/dashboard.ts";
import { DomainDnsService } from "./domain-dns.service.ts";
import { PangolinService } from "./pangolin.service.ts";

const logger = new Logger("DNS");

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface DnsSyncOptions {
	sso?: boolean;
}

const providers = [
	{
		delete: (hostname: string) => DomainDnsService.deleteHostname(hostname),
		name: "dns",
		sync: (hostname: string, _opts: DnsSyncOptions) =>
			DomainDnsService.syncHostname(hostname),
	},
	{
		delete: (hostname: string) => PangolinService.deleteDnsRecord(hostname),
		name: "pangolin",
		sync: (hostname: string, opts: DnsSyncOptions) =>
			PangolinService.syncDnsRecord(hostname, opts),
	},
];

/** The public hostname a service resolves at, the same `defaultHostname` Traefik routes. */
export function serviceHostname(
	slug: string,
	stackSlug: string | null | undefined,
): string {
	return defaultHostname(slug, stackSlug, config.baseDomain);
}

/**
 * Runs every configured provider over every hostname and returns what each
 * one did. A provider that isn't configured returns null and is dropped, so
 * an empty array means "no DNS automation is on", not "nothing happened".
 * Neither provider throws, but a rejection is still reported rather than
 * dropped, since silently swallowing one is the bug this replaced.
 */
async function fanOut(
	op: "delete" | "sync",
	hostnames: string[],
	opts: DnsSyncOptions = {},
): Promise<DnsSyncResult[]> {
	const tasks = providers.flatMap((provider) =>
		hostnames.map((hostname) =>
			(op === "sync"
				? provider.sync(hostname, opts)
				: provider.delete(hostname)
			)
				.then((result) =>
					result
						? { ...result, detail: `${hostname}: ${result.detail}` }
						: null,
				)
				.catch(
					(err: unknown): DnsSyncResult => ({
						detail: `${hostname}: ${err instanceof Error ? err.message : String(err)}`,
						ok: false,
						provider: provider.name,
					}),
				),
		),
	);
	const results = await Promise.all(tasks);
	return results.filter((result): result is DnsSyncResult => result !== null);
}

/** Syncs a DNS/routing record for each hostname across every configured provider (see `fanOut`). */
export function syncDns(
	hostnames: string[],
	opts: DnsSyncOptions = {},
): Promise<DnsSyncResult[]> {
	return fanOut("sync", hostnames, opts);
}

/** Deletes a DNS/routing record for each hostname across every configured provider (see `fanOut`). */
export function deleteDns(hostnames: string[]): Promise<DnsSyncResult[]> {
	return fanOut("delete", hostnames);
}

/**
 * Syncs the dashboard's own hostname (derived from the configured auth
 * origin) to any configured provider, skipping a bare IP or a hostname
 * without a dot (nothing meaningful to route). Logs the outcome per
 * provider rather than returning it, since nothing awaits this call.
 */
export async function syncDashboardDns(): Promise<void> {
	const host = dashboardHostFrom(config.auth.origin ?? null);
	if (!host?.includes(".") || IPV4_RE.test(host)) {
		return;
	}
	const results = await syncDns([host], { sso: false });
	for (const result of results) {
		if (result.ok) {
			logger.info(`Dashboard (${result.provider}): ${result.detail}`);
		} else {
			logger.warn(
				`Dashboard sync failed (${result.provider}): ${result.detail}`,
			);
		}
	}
}

/**
 * Syncs a core service's public hostname (the built-in registry's, the
 * built-in object store's) to every configured provider and deletes the one
 * it replaced, without Pangolin SSO: `docker login`, `docker push` and S3
 * clients can't follow a sign-in redirect. Without it, nothing routes the
 * host to this server's Traefik. Logs the outcome rather than returning it,
 * since nothing awaits this call.
 */
export async function syncCoreHostDns(
	label: string,
	previous: string | null,
	next: string | null,
): Promise<void> {
	const results = [
		...(next ? await syncDns([next], { sso: false }) : []),
		...(previous && previous !== next ? await deleteDns([previous]) : []),
	];
	for (const result of results) {
		if (result.ok) {
			logger.info(`${label} (${result.provider}): ${result.detail}`);
		} else {
			logger.warn(
				`${label} sync failed (${result.provider}): ${result.detail}`,
			);
		}
	}
}

/**
 * The hosts of a service's `previous` domain entries that `next` no longer
 * has and no other service than `serviceId` still routes: the ones whose DNS
 * records can go. A domain with a path shares its host, so dropping
 * `example.com/api` frees nothing while another service serves `example.com`.
 */
export async function releasedHosts(
	previous: string[],
	next: string[],
	serviceId?: string,
): Promise<string[]> {
	const nextHosts = domainHosts(next);
	const dropped = domainHosts(previous).filter(
		(host) => !nextHosts.includes(host),
	);
	if (dropped.length === 0) {
		return [];
	}
	const routed = await serviceRoutedHosts(serviceId);
	return dropped.filter((host) => !routed.has(host));
}

/**
 * Brings DNS in line with a service's edited domains right away, rather than
 * on its next deploy: syncs the host of every entry in `next` and deletes the
 * hosts `releasedHosts` frees, across every configured provider. Logs the
 * outcome per hostname and provider rather than returning it.
 */
export async function syncServiceDomainsDns(
	previous: string[],
	next: string[],
	serviceId?: string,
): Promise<void> {
	const results = [
		...(await syncDns(domainHosts(next))),
		...(await deleteDns(await releasedHosts(previous, next, serviceId))),
	];
	for (const result of results) {
		if (result.ok) {
			logger.info(`Service domain (${result.provider}): ${result.detail}`);
		} else {
			logger.warn(
				`Service domain sync failed (${result.provider}): ${result.detail}`,
			);
		}
	}
}
