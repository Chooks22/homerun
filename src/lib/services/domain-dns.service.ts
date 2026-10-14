import { config } from "#lib/config.js";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DnsManagedRecordDTO } from "#lib/dto/dns-managed-record-dto.js";
import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { bareTarget, inZone, normalizeName } from "./dns-providers/http.ts";
import type {
	DnsProviderClient,
	DnsRecord,
	DnsRecordInput,
	DnsZone,
} from "./dns-providers/types.ts";
import type { DnsSyncResult } from "./dns-result.ts";

const logger = new Logger("DNS");

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

/**
 * The record a hostname needs to reach `target`: an A record for an IPv4
 * address, AAAA for an IPv6 one, a CNAME for a hostname. Null when the
 * target is the hostname itself, or a CNAME would sit on the zone apex,
 * which DNS doesn't allow.
 */
export function recordFor(
	hostname: string,
	target: string,
	zoneApex: string,
): DnsRecordInput | null {
	const name = normalizeName(hostname);
	const value = target.trim();
	if (IPV4.test(value)) {
		return { content: value, name, type: "A" };
	}
	if (value.includes(":")) {
		return { content: value, name, type: "AAAA" };
	}
	const host = normalizeName(value);
	if (host === name || name === normalizeName(zoneApex)) {
		return null;
	}
	return { content: host, name, type: "CNAME" };
}

/** Whether a provider's record already holds what `input` asks for. */
function sameRecord(record: DnsRecord, input: DnsRecordInput): boolean {
	return (
		record.type === input.type &&
		bareTarget(normalizeName(record.content)) ===
			bareTarget(normalizeName(input.content))
	);
}

interface Managed {
	client: DnsProviderClient;
	connection: DnsConnectionDTO;
	domain: DomainDTO;
	zone: DnsZone;
}

/**
 * Keeps the DNS records of services' hostnames in step with the domains the
 * instance manages: a hostname under a domain linked to a DNS connection's
 * zone gets the record pointing at the domain's target (the base domain
 * unless set) created, fixed and removed as services come and go. It only
 * ever touches records it created (`DnsManagedRecordDTO`); a record someone
 * made by hand on the same name is reported and left alone.
 */
class DomainDnsServiceClass {
	/** The domain, connection, client and zone that manage `hostname`, null when none does or automation is off there. */
	async #managing(hostname: string, automatic = true): Promise<Managed | null> {
		const domain = await DomainDTO.forHostname(hostname);
		const row = domain?.toJSON();
		if (!domain || !row?.connectionId || (automatic && !row.autoRecords)) {
			return null;
		}
		const zone = domain.zone();
		const connection = await DnsConnectionDTO.get(row.connectionId);
		if (!zone || !connection) {
			return null;
		}
		return { client: connection.client(), connection, domain, zone };
	}

	/** Where a domain's service records point: its own target, else the base domain. */
	targetOf(domain: DomainDTO): string | null {
		return domain.toJSON().target ?? config.baseDomain ?? null;
	}

	/**
	 * Creates or corrects the record for one service hostname.
	 *
	 * @returns What happened, or null when no managed domain covers the hostname.
	 */
	async syncHostname(hostname: string): Promise<DnsSyncResult | null> {
		const managed = await this.#managing(hostname);
		if (!managed) {
			return null;
		}
		const { client, connection, domain, zone } = managed;
		const provider = connection.name;
		const target = this.targetOf(domain);
		if (!target) {
			return {
				detail: "set where the domain's records point first",
				ok: false,
				provider,
			};
		}
		const wanted = recordFor(hostname, target, zone.name);
		if (!wanted) {
			return {
				detail: `left alone (it's the target, or the zone apex with a hostname target)`,
				ok: true,
				provider,
			};
		}
		const name = normalizeName(hostname);
		const existing = (await client.listRecords(zone)).filter(
			(record) =>
				normalizeName(record.name) === name && ADDRESS_TYPES.has(record.type),
		);
		const tracked = await DnsManagedRecordDTO.find(domain.id, name);
		const current = tracked
			? existing.find((record) => record.id === tracked.asRecord().id)
			: undefined;
		if (current && sameRecord(current, wanted)) {
			return {
				detail: `${wanted.type} ${wanted.content} (unchanged)`,
				ok: true,
				provider,
			};
		}
		if (current && current.type === wanted.type) {
			const updated = await client.updateRecord(zone, current, wanted);
			await DnsManagedRecordDTO.track(domain.id, updated);
			return {
				detail: `updated ${wanted.type} → ${wanted.content}`,
				ok: true,
				provider,
			};
		}
		if (current) {
			await client.deleteRecord(zone, current);
		}
		const foreign = existing.find((record) => record.id !== current?.id);
		if (foreign) {
			return sameRecord(foreign, wanted)
				? {
						detail: `already ${foreign.type} ${foreign.content} (a record you manage)`,
						ok: true,
						provider,
					}
				: {
						detail: `has a ${foreign.type} record Homerun didn't create (${foreign.content}), left alone`,
						ok: false,
						provider,
					};
		}
		const created = await client.createRecord(zone, wanted);
		await DnsManagedRecordDTO.track(domain.id, created);
		return {
			detail: `created ${wanted.type} → ${wanted.content}`,
			ok: true,
			provider,
		};
	}

	/**
	 * Deletes the record Homerun created for a hostname that's gone.
	 *
	 * @returns What happened, or null when it manages no record for it.
	 */
	async deleteHostname(hostname: string): Promise<DnsSyncResult | null> {
		const managed = await this.#managing(hostname, false);
		const tracked = managed
			? await DnsManagedRecordDTO.find(managed.domain.id, hostname)
			: null;
		if (!managed || !tracked) {
			return null;
		}
		await managed.client.deleteRecord(managed.zone, tracked.asRecord());
		await tracked.untrack();
		return { detail: "deleted", ok: true, provider: managed.connection.name };
	}

	/** A domain's client and zone for editing its records by hand, however its automation is set. */
	async #editable(domain: DomainDTO): Promise<Managed> {
		const row = domain.toJSON();
		const zone = domain.zone();
		const connection = row.connectionId
			? await DnsConnectionDTO.get(row.connectionId)
			: null;
		if (!zone || !connection) {
			throw new Error("Link the domain to a DNS provider zone first.");
		}
		return { client: connection.client(), connection, domain, zone };
	}

	/**
	 * Every record in a domain's zone that belongs to the domain (the zone can
	 * hold other domains), with whether Homerun created it.
	 *
	 * @throws When the domain isn't linked to a zone, or the provider refuses.
	 */
	async records(
		domain: DomainDTO,
	): Promise<(DnsRecord & { managed: boolean })[]> {
		const { client, zone } = await this.#editable(domain);
		const managed = new Set(
			(await DnsManagedRecordDTO.listForDomain(domain.id)).map(
				(record) => record.asRecord().id,
			),
		);
		return (await client.listRecords(zone))
			.filter((record) => inZone(record.name, domain.name))
			.map((record) => ({ ...record, managed: managed.has(record.id) }))
			.sort(
				(a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
			);
	}

	/**
	 * Adds a record by hand. It's the admin's, so Homerun doesn't track it.
	 *
	 * @throws When the name isn't under the domain, or the provider refuses.
	 */
	async createRecord(
		domain: DomainDTO,
		input: DnsRecordInput,
	): Promise<DnsRecord> {
		const { client, zone } = await this.#editable(domain);
		if (!inZone(input.name, domain.name)) {
			throw new Error(`${input.name} isn't under ${domain.name}.`);
		}
		return await client.createRecord(zone, input);
	}

	/**
	 * Replaces one record's value by hand; a record Homerun created stays
	 * tracked with the new value.
	 *
	 * @returns The record as the provider holds it now, its id changed on
	 *   providers that derive it from the value.
	 * @throws When the record is gone, or the provider refuses.
	 */
	async updateRecord(
		domain: DomainDTO,
		recordId: string,
		input: DnsRecordInput,
	): Promise<DnsRecord> {
		const { client, zone } = await this.#editable(domain);
		const record = (await client.listRecords(zone)).find(
			(candidate) => candidate.id === recordId,
		);
		if (!record) {
			throw new Error("That record doesn't exist any more.");
		}
		const updated = await client.updateRecord(zone, record, input);
		const tracked = await DnsManagedRecordDTO.find(domain.id, record.name);
		if (tracked?.asRecord().id === recordId) {
			await DnsManagedRecordDTO.track(domain.id, updated);
		}
		return updated;
	}

	/**
	 * Deletes one record by hand, and stops tracking it when Homerun made it.
	 *
	 * @throws When the provider refuses.
	 */
	async deleteRecord(domain: DomainDTO, recordId: string): Promise<void> {
		const { client, zone } = await this.#editable(domain);
		const record = (await client.listRecords(zone)).find(
			(candidate) => candidate.id === recordId,
		);
		if (!record) {
			return;
		}
		await client.deleteRecord(zone, record);
		const tracked = await DnsManagedRecordDTO.find(domain.id, record.name);
		if (tracked?.asRecord().id === recordId) {
			await tracked.untrack();
		}
	}

	/**
	 * Points a domain itself at the server: its apex (only when the target
	 * is an IP, a CNAME can't sit there) and a wildcard, so every name under
	 * it reaches the server without a record each.
	 *
	 * @returns One line per record.
	 * @throws When the domain isn't linked to a zone, or has no target.
	 */
	async pointAtServer(domain: DomainDTO): Promise<string[]> {
		const managed = await this.#managing(domain.name, false);
		const target = this.targetOf(domain);
		if (!managed || !target) {
			throw new Error(
				"Link the domain to a DNS provider zone and set its target first.",
			);
		}
		const lines: string[] = [];
		for (const hostname of [domain.name, `*.${domain.name}`]) {
			const wanted = recordFor(
				hostname,
				target,
				hostname.startsWith("*.") ? "" : domain.name,
			);
			if (!wanted) {
				lines.push(
					`${hostname}: needs an IP target (a CNAME can't sit on the apex)`,
				);
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- two records, in order
			const existing = (await managed.client.listRecords(managed.zone)).filter(
				(record) =>
					normalizeName(record.name) === normalizeName(hostname) &&
					ADDRESS_TYPES.has(record.type),
			);
			const same = existing.find((record) => sameRecord(record, wanted));
			if (same) {
				lines.push(`${hostname}: already ${wanted.type} ${wanted.content}`);
				continue;
			}
			if (existing.length > 0) {
				lines.push(
					`${hostname}: has a ${existing[0]?.type} record already, left alone`,
				);
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- see above
			const created = await managed.client.createRecord(managed.zone, wanted);
			// oxlint-disable-next-line no-await-in-loop -- see above
			await DnsManagedRecordDTO.track(managed.domain.id, created);
			lines.push(`${hostname}: created ${wanted.type} → ${wanted.content}`);
		}
		logger.info(
			`Domain pointed at the server: ${domain.name} ${lines.join("; ")}`,
		);
		return lines;
	}
}

export const DomainDnsService = new DomainDnsServiceClass();
