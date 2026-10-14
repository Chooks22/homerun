import type { DomainInput } from "#lib/dto/domain-dto.js";
import {
	absoluteName,
	normalizeName,
} from "#lib/services/dns-providers/http.js";
import {
	DNS_RECORD_TYPES,
	type DnsCredentials,
	type DnsProviderDefinition,
	type DnsRecordInput,
	type DnsRecordType,
} from "#lib/services/dns-providers/types.js";

type Parsed<T> = { error: string; value: null } | { error: null; value: T };

const HOSTNAME =
	/^(?=.{1,253}$)(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Where a form's fields come from: its FormData, or a Map built from a JSON body. */
export interface FormFields {
	get(name: string): unknown;
}

/** A form field's trimmed value, empty when missing. */
function text(formData: FormFields, key: string): string {
	return String(formData.get(key) ?? "").trim();
}

/** Whether `name` is a domain name a domain can be added under, like example.com. */
export function isDomainName(name: string): boolean {
	return HOSTNAME.test(normalizeName(name));
}

/** Whether `value` is a hostname or an IP address a record can point at. */
export function isTarget(value: string): boolean {
	return (
		IPV4.test(value) ||
		value.includes(":") ||
		HOSTNAME.test(normalizeName(value))
	);
}

/**
 * Reads a DNS connection form for `provider`: a name and each of its
 * credential fields. A required field may be left blank only when `editing`,
 * which keeps the stored value.
 */
export function parseConnectionForm(
	formData: FormFields,
	provider: DnsProviderDefinition,
	editing = false,
): Parsed<{ credentials: DnsCredentials; name: string }> {
	const name = text(formData, "name") || provider.name;
	const credentials: DnsCredentials = {};
	for (const field of provider.fields) {
		const value = text(formData, `field_${field.key}`);
		if (!value && !field.optional && !editing) {
			return { error: `${field.label} is required.`, value: null };
		}
		if (value) {
			credentials[field.key] = value;
		}
	}
	return { error: null, value: { credentials, name } };
}

/** A DNS connection form's fields from a JSON body: its name, and each credential as `field_<key>`. */
export function connectionFields(body: {
	credentials?: Record<string, string>;
	name?: string;
}): Map<string, string> {
	return new Map([
		["name", body.name ?? ""],
		...Object.entries(body.credentials ?? {}).map(
			([key, value]): [string, string] => [`field_${key}`, value],
		),
	]);
}

/**
 * Reads the add or edit domain form: a domain name (only when adding), the
 * connection and zone it's managed in (both or neither), where its services'
 * records point (an IP or a hostname, blank for the base domain) and whether
 * they're created automatically.
 */
export function parseDomainForm(
	formData: FormData,
	withName: boolean,
): Parsed<DomainInput> {
	const name = normalizeName(text(formData, "name"));
	if (withName && !isDomainName(name)) {
		return { error: "Enter a domain name, like example.com.", value: null };
	}
	const connectionId = text(formData, "connectionId") || null;
	const zone = text(formData, "zone");
	const [zoneId, zoneName] = zone ? zone.split("|") : [null, null];
	if (connectionId && !zoneId) {
		return { error: "Pick the zone the domain lives in.", value: null };
	}
	const target = text(formData, "target") || null;
	if (target && !isTarget(target)) {
		return {
			error: "Point records at an IP address or a hostname.",
			value: null,
		};
	}
	return {
		error: null,
		value: {
			autoRecords: formData.get("autoRecords") === "on",
			connectionId,
			name,
			target,
			zoneId: connectionId ? (zoneId ?? null) : null,
			zoneName: connectionId ? (zoneName ?? null) : null,
		},
	};
}

/**
 * Reads the record form for `domainName`: a name (`@`, a label, or a full
 * name under the domain), a type, its value, an optional TTL and, for MX, a
 * priority.
 */
export function parseRecordForm(
	formData: FormData,
	domainName: string,
): Parsed<DnsRecordInput> {
	const type = text(formData, "type").toUpperCase() as DnsRecordType;
	if (!DNS_RECORD_TYPES.includes(type)) {
		return { error: "Pick a record type.", value: null };
	}
	const name = absoluteName(text(formData, "name") || "@", {
		id: "",
		name: domainName,
	});
	const content = text(formData, "content");
	if (!content) {
		return { error: "Enter the record's value.", value: null };
	}
	if (type === "A" && !IPV4.test(content)) {
		return { error: "An A record's value is an IPv4 address.", value: null };
	}
	if (type === "AAAA" && !content.includes(":")) {
		return { error: "An AAAA record's value is an IPv6 address.", value: null };
	}
	if (
		(type === "CNAME" || type === "MX") &&
		!HOSTNAME.test(normalizeName(content))
	) {
		return { error: `A ${type} record's value is a hostname.`, value: null };
	}
	const ttlRaw = text(formData, "ttl");
	const ttl = ttlRaw ? Number(ttlRaw) : null;
	if (ttl !== null && !(Number.isInteger(ttl) && ttl >= 60 && ttl <= 86_400)) {
		return {
			error:
				"TTL is a whole number of seconds from 60 to 86400, or blank for automatic.",
			value: null,
		};
	}
	const priorityRaw = text(formData, "priority");
	const priority = type === "MX" ? Number(priorityRaw || "10") : null;
	if (
		priority !== null &&
		!(Number.isInteger(priority) && priority >= 0 && priority <= 65_535)
	) {
		return {
			error: "MX priority is a whole number from 0 to 65535.",
			value: null,
		};
	}
	return { error: null, value: { content, name, priority, ttl, type } };
}
