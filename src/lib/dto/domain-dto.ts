import { asc, eq } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type Domain, domain } from "#lib/server/db/schema.js";
import { inZone, normalizeName } from "#lib/services/dns-providers/http.js";
import type { DnsZone } from "#lib/services/dns-providers/types.js";
import { BaseDTO } from "./base-dto";

export type DomainInput = Pick<
	Domain,
	| "autoRecords"
	| "connectionId"
	| "dnsChallenge"
	| "name"
	| "target"
	| "zoneId"
	| "zoneName"
>;

/**
 * Wraps `domain`: a domain the instance manages, optionally linked to a DNS
 * connection's zone so the records of services' hostnames under it are
 * created and removed automatically. `target` is what those records point
 * at: an IP (A/AAAA) or a hostname (CNAME), the base domain when unset.
 */
export class DomainDTO extends BaseDTO<Domain> {
	/** Every domain, alphabetically. */
	static async list(): Promise<DomainDTO[]> {
		const rows = await db.select().from(domain).orderBy(asc(domain.name));
		return rows.map((row) => new DomainDTO(row));
	}

	/** One domain, null when it doesn't exist. */
	static async get(id: string): Promise<DomainDTO | null> {
		const [row] = await db
			.select()
			.from(domain)
			.where(eq(domain.id, id))
			.limit(1);
		return row ? new DomainDTO(row) : null;
	}

	/** The most specific domain `hostname` falls under, null when none does. */
	static async forHostname(hostname: string): Promise<DomainDTO | null> {
		const matches = (await DomainDTO.list()).filter((candidate) =>
			inZone(hostname, candidate.name),
		);
		return matches.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
	}

	/**
	 * Adds a domain.
	 *
	 * @throws When a domain with that name exists already.
	 */
	static async create(
		input: DomainInput & { userId: string },
	): Promise<DomainDTO> {
		const row: Domain = {
			...input,
			createdAt: new Date(),
			id: crypto.randomUUID(),
			name: normalizeName(input.name),
			target: input.target?.trim() || null,
		};
		await db.insert(domain).values(row);
		return new DomainDTO(row);
	}

	/** Saves the domain's connection, zone, target and automation switches. */
	async update(input: Partial<Omit<DomainInput, "name">>): Promise<void> {
		await db.update(domain).set(input).where(eq(domain.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Removes the domain from Homerun; its records at the provider stay. */
	async delete(): Promise<void> {
		await db.delete(domain).where(eq(domain.id, this.row.id));
	}

	/** The domain's id. */
	get id(): string {
		return this.row.id;
	}

	/** The domain name, e.g. example.com. */
	get name(): string {
		return this.row.name;
	}

	/** The DNS connection its records are managed through, null when unmanaged. */
	get connectionId(): string | null {
		return this.row.connectionId;
	}

	/** The provider zone the domain lives in, null until one is picked. */
	zone(): DnsZone | null {
		return this.row.zoneId
			? { id: this.row.zoneId, name: this.row.zoneName ?? this.row.name }
			: null;
	}
}
