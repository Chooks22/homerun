import { timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ACME_DNS_USERNAME,
	ACME_WILDCARD_ROUTER_FILE,
	acmeDnsPassword,
	acmeWildcardRouterConfig,
	challengeDomainFor,
	challengeHostname,
	dnsChallengeSetup,
} from "#lib/acme-dns.js";
import { config, serviceDomain, setDnsChallengeDomains } from "#lib/config.js";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { normalizeName } from "./dns-providers/http.ts";
import type { DnsProviderClient, DnsZone } from "./dns-providers/types.ts";
import { DockerService } from "./docker.service.ts";
import { RedirectService } from "./redirect.service.ts";
import { StatusPageSettingsService } from "./status-page-settings.service.ts";

const logger = new Logger("ACME");

const CHALLENGE_TTL = 60;

export type AcmeDnsAction = "cleanup" | "present";

/** A challenge request refused before reaching a DNS provider. */
export class AcmeDnsError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/**
 * Certificates through ACME DNS-01 for the domains that opt in
 * (`domain.dnsChallenge`): Traefik's httpreq provider asks this app to put
 * and remove the `_acme-challenge` TXT records, which it does through the
 * domain's own DNS connection, so every provider Homerun supports works
 * without handing Traefik any credential. Each such domain gets one wildcard
 * certificate, requested by a router in its own dynamic config file.
 */
class AcmeDnsServiceClass {
	/** The domains whose certificates come from DNS-01: opted in and linked to a connection's zone. */
	async challengeDomains(): Promise<string[]> {
		return (await DomainDTO.list())
			.filter((domain) => {
				const row = domain.toJSON();
				return row.dnsChallenge && row.connectionId && row.zoneId;
			})
			.map((domain) => domain.name);
	}

	/** Loads the DNS-challenge domains into the live config, which `certResolverFor` reads. */
	async load(): Promise<string[]> {
		const domains = await this.challengeDomains();
		setDnsChallengeDomains(domains);
		return domains;
	}

	/**
	 * Writes the wildcard routers' dynamic config file, or removes it when no
	 * domain uses DNS-01. Failures are logged, not thrown.
	 */
	async syncRouters(): Promise<void> {
		const dir = config.traefik.dynamicConfigDir;
		if (!dir) {
			return;
		}
		const path = join(dir, ACME_WILDCARD_ROUTER_FILE);
		const yaml = config.pangolinEnabled
			? null
			: acmeWildcardRouterConfig({
					domains: config.traefik.dnsChallengeDomains,
					entrypoint: config.traefik.entrypoint,
					serviceDomain: serviceDomain(),
				});
		try {
			if (yaml) {
				await mkdir(dir, { recursive: true });
				await writeFile(path, yaml);
			} else {
				await rm(path, { force: true });
			}
		} catch (err) {
			logger.error("Couldn't write the wildcard certificate routers", err);
		}
	}

	/**
	 * Reloads the DNS-challenge domains after a domain or connection change
	 * and converges everything that depends on them: the wildcard routers,
	 * Traefik's DNS-01 resolver, and the file routers Homerun writes itself
	 * (dashboard, redirects, status pages). Services' own labels pick the
	 * change up on their next deploy. Failures are logged, not thrown.
	 */
	async sync(): Promise<void> {
		const domains = await this.load();
		await this.syncRouters();
		await DockerService.applyDnsChallenge(
			domains.length > 0 && !config.pangolinEnabled
				? dnsChallengeSetup(config.authCheckUrl, config.auth.secret)
				: null,
		).catch((err) => {
			logger.warn("Couldn't apply the DNS challenge resolver to Traefik", err);
		});
		await DockerService.syncDashboardRouter();
		await RedirectService.sync();
		await StatusPageSettingsService.syncRoutes();
	}

	/** Whether an `Authorization` header carries the credentials Traefik was given. */
	authorized(header: string | null): boolean {
		const match = header?.match(/^Basic\s+(\S+)$/i);
		if (!match?.[1]) {
			return false;
		}
		let decoded: string;
		try {
			decoded = atob(match[1]);
		} catch {
			return false;
		}
		const expected = Buffer.from(
			`${ACME_DNS_USERNAME}:${acmeDnsPassword(config.auth.secret)}`,
		);
		const given = Buffer.from(decoded);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	/**
	 * Adds (`present`) or removes (`cleanup`) a challenge TXT record through
	 * the connection of the most specific DNS-challenge domain covering it.
	 * Adding keeps other values on the name, since a domain's apex and
	 * wildcard are validated on the same name at once.
	 *
	 * @throws {AcmeDnsError} When the name isn't a challenge record under a
	 *   DNS-challenge domain.
	 */
	async handle(
		action: AcmeDnsAction,
		fqdn: string,
		value: string,
	): Promise<void> {
		const name = challengeHostname(fqdn);
		if (!name.startsWith("_acme-challenge.") || !value) {
			throw new AcmeDnsError("Not an ACME challenge record.", 400);
		}
		const { client, zone } = await this.#managing(name);
		const existing = (await client.listRecords(zone)).filter(
			(record) =>
				record.type === "TXT" &&
				normalizeName(record.name) === name &&
				record.content === value,
		);
		if (action === "present") {
			if (existing.length === 0) {
				await client.createRecord(zone, {
					content: value,
					name,
					ttl: CHALLENGE_TTL,
					type: "TXT",
				});
			}
			logger.info(`Challenge record set: ${name}`);
			return;
		}
		await Promise.all(
			existing.map((record) => client.deleteRecord(zone, record)),
		);
		logger.info(`Challenge record removed: ${name}`);
	}

	/**
	 * The client and zone of the DNS-challenge domain covering `name`.
	 *
	 * @throws {AcmeDnsError} When none does or its connection is gone.
	 */
	async #managing(
		name: string,
	): Promise<{ client: DnsProviderClient; zone: DnsZone }> {
		const domainName = challengeDomainFor(name, await this.challengeDomains());
		const domain = domainName
			? (await DomainDTO.list()).find(
					(candidate) => candidate.name === domainName,
				)
			: null;
		const zone = domain?.zone() ?? null;
		const connection = domain?.connectionId
			? await DnsConnectionDTO.get(domain.connectionId)
			: null;
		if (!zone || !connection) {
			throw new AcmeDnsError(
				`No domain issuing certificates through DNS covers ${name}.`,
				404,
			);
		}
		return { client: connection.client(), zone };
	}
}

export const AcmeDnsService = new AcmeDnsServiceClass();
