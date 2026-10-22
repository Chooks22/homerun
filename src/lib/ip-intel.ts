import { ipv6Value, normalizeIp } from "#lib/ip-bans.js";

export interface IpIntel {
	abuseEmail: string | null;
	asName: string | null;
	asn: number | null;
	country: string | null;
	hostname: string | null;
	lookedUpAt: string;
	network: string | null;
	networkName: string | null;
	org: string | null;
	registry: string | null;
}

/** The DNS name Team Cymru answers `ip`'s origin AS on, or null when it isn't an IP address. */
export function cymruOriginName(ip: string): string | null {
	const value = normalizeIp(ip);
	if (!value) {
		return null;
	}
	if (!value.includes(":")) {
		return `${value.split(".").reverse().join(".")}.origin.asn.cymru.com`;
	}
	const bits = ipv6Value(value);
	if (bits === null) {
		return null;
	}
	const nibbles = bits.toString(16).padStart(32, "0").split("").reverse();
	return `${nibbles.join(".")}.origin6.asn.cymru.com`;
}

function cymruFields(txt: string | undefined): string[] {
	return (txt ?? "").split("|").map((field) => field.trim());
}

/** The AS number, announced prefix, country and registry from a Cymru origin TXT answer (`15169 | 8.8.8.0/24 | US | arin | …`). */
export function parseCymruOrigin(txt: string | undefined): {
	asn: number | null;
	country: string | null;
	network: string | null;
	registry: string | null;
} {
	const [asn, network, country, registry] = cymruFields(txt);
	const first = Number.parseInt(asn?.split(" ")[0] ?? "", 10);
	return {
		asn: Number.isFinite(first) ? first : null,
		country: country || null,
		network: network || null,
		registry: registry || null,
	};
}

/** The AS name from a Cymru AS TXT answer (`15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US`). */
export function parseCymruAsName(txt: string | undefined): string | null {
	return cymruFields(txt)[4] || null;
}

type VcardEntry = [string, unknown, string, unknown];

interface RdapEntity {
	entities?: RdapEntity[];
	roles?: string[];
	vcardArray?: [string, VcardEntry[]];
}

interface RdapNetwork extends RdapEntity {
	country?: string;
	name?: string;
}

function vcardValue(entity: RdapEntity, key: string): string | null {
	const entry = entity.vcardArray?.[1]?.find((item) => item[0] === key);
	const value = entry?.[3];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function flatten(entities: RdapEntity[] | undefined): RdapEntity[] {
	return (entities ?? []).flatMap((entity) => [
		entity,
		...flatten(entity.entities),
	]);
}

function withRole(entities: RdapEntity[], role: string): RdapEntity[] {
	return entities.filter((entity) => entity.roles?.includes(role));
}

/** The network name, owning organisation, country and abuse contact from an RDAP IP network answer. */
export function parseRdap(body: unknown): {
	abuseEmail: string | null;
	country: string | null;
	networkName: string | null;
	org: string | null;
} {
	if (!body || typeof body !== "object") {
		return { abuseEmail: null, country: null, networkName: null, org: null };
	}
	const network = body as RdapNetwork;
	const entities = flatten(network.entities);
	const owner = [
		...withRole(entities, "registrant"),
		...withRole(entities, "administrative"),
	]
		.map((entity) => vcardValue(entity, "fn"))
		.find(Boolean);
	const abuse = withRole(entities, "abuse")
		.map((entity) => vcardValue(entity, "email"))
		.find(Boolean);
	return {
		abuseEmail: abuse ?? null,
		country: network.country?.trim() || null,
		networkName: network.name?.trim() || null,
		org: owner ?? null,
	};
}

/** A one-line description of who `intel` says is behind an address: AS, owner, country and hostname, whichever are known. */
export function intelSummary(intel: IpIntel | null): string | null {
	if (!intel) {
		return null;
	}
	const parts = [
		intel.asn
			? `AS${intel.asn}${intel.asName ? ` ${intel.asName}` : ""}`
			: null,
		intel.org && !intel.asName?.includes(intel.org) ? intel.org : null,
		intel.country,
		intel.hostname,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : null;
}
