import { describe, expect, test } from "bun:test";
import {
	connectionFields,
	isTarget,
	parseConnectionForm,
	parseDomainForm,
	parseRecordForm,
} from "../../../src/lib/server/validation/dns-forms";
import { cloudflare } from "../../../src/lib/services/dns-providers/cloudflare";

function form(values: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(values)) {
		data.set(key, value);
	}
	return data;
}

describe("parseConnectionForm", () => {
	test("requires each field when adding, keeps blanks when editing", () => {
		expect(parseConnectionForm(form({}), cloudflare).error).toBe(
			"API token is required.",
		);
		expect(
			parseConnectionForm(form({ field_apiToken: " t " }), cloudflare).value,
		).toEqual({
			credentials: { apiToken: "t" },
			name: "Cloudflare",
		});
		expect(
			parseConnectionForm(form({ name: "Work" }), cloudflare, true).value,
		).toEqual({ credentials: {}, name: "Work" });
	});
});

describe("parseDomainForm", () => {
	test("reads the name, connection and zone together, and checks the target", () => {
		expect(
			parseDomainForm(
				form({
					autoRecords: "on",
					connectionId: "c1",
					dnsChallenge: "on",
					name: "Example.com.",
					target: "203.0.113.10",
					zone: "z1|example.com",
				}),
				true,
			).value,
		).toEqual({
			autoRecords: true,
			connectionId: "c1",
			dnsChallenge: true,
			name: "example.com",
			target: "203.0.113.10",
			zoneId: "z1",
			zoneName: "example.com",
		});
		expect(parseDomainForm(form({ name: "nope" }), true).error).toContain(
			"domain name",
		);
		expect(
			parseDomainForm(form({ connectionId: "c1", name: "example.com" }), true)
				.error,
		).toContain("zone");
		expect(
			parseDomainForm(form({ name: "example.com", target: "not a host" }), true)
				.error,
		).toContain("IP address");
	});
});

describe("parseRecordForm", () => {
	test("turns a relative name into a full one and validates each type's value", () => {
		expect(
			parseRecordForm(
				form({ content: "203.0.113.10", name: "app", type: "A" }),
				"example.com",
			).value,
		).toEqual({
			content: "203.0.113.10",
			name: "app.example.com",
			priority: null,
			ttl: null,
			type: "A",
		});
		expect(
			parseRecordForm(
				form({ content: "mx.example.net", name: "@", type: "MX" }),
				"example.com",
			).value,
		).toMatchObject({ name: "example.com", priority: 10 });
		expect(
			parseRecordForm(
				form({ content: "host", name: "app", type: "A" }),
				"example.com",
			).error,
		).toContain("IPv4");
		expect(
			parseRecordForm(
				form({ content: "1.2.3.4", name: "app", ttl: "5", type: "A" }),
				"example.com",
			).error,
		).toContain("TTL");
		expect(
			parseRecordForm(
				form({ content: "x", name: "app", type: "NS" }),
				"example.com",
			).error,
		).toContain("type");
	});

	test("isTarget accepts IPs and hostnames", () => {
		expect([
			isTarget("203.0.113.10"),
			isTarget("2001:db8::1"),
			isTarget("host.example.net"),
			isTarget("no spaces"),
		]).toEqual([true, true, true, false]);
	});
});

describe("DNS_PROVIDERS", () => {
	test("every provider has a unique id, a docs link and described credential fields", async () => {
		const { DNS_PROVIDERS, dnsProviderById } = await import(
			"../../../src/lib/services/dns-providers"
		);
		expect(DNS_PROVIDERS).toHaveLength(16);
		expect(new Set(DNS_PROVIDERS.map((provider) => provider.id)).size).toBe(16);
		for (const provider of DNS_PROVIDERS) {
			expect(provider.docsUrl).toStartWith("https://");
			expect(provider.fields.length).toBeGreaterThan(0);
			expect(provider.fields.every((field) => field.help || field.label)).toBe(
				true,
			);
			expect(provider.fields.some((field) => field.secret)).toBe(true);
			expect(dnsProviderById(provider.id)).toBe(provider);
		}
		expect(dnsProviderById("nope")).toBeNull();
	});
});

describe("connectionFields", () => {
	test("maps a JSON body onto the connection form's fields", () => {
		const fields = connectionFields({
			credentials: { apiToken: "abc" },
			name: "Main",
		});
		expect(fields.get("name")).toBe("Main");
		expect(fields.get("field_apiToken")).toBe("abc");
		const parsed = parseConnectionForm(
			connectionFields({ credentials: {} }),
			cloudflare,
			true,
		);
		expect(parsed.error).toBeNull();
		expect(parsed.value?.name).toBe(cloudflare.name);
	});
});
