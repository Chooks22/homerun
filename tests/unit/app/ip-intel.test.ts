import { describe, expect, test } from "bun:test";
import {
	cymruOriginName,
	intelSummary,
	parseCymruAsName,
	parseCymruOrigin,
	parseRdap,
} from "../../../src/lib/ip-intel";

describe("Cymru lookups", () => {
	test("an IPv4 address reverses its octets under origin.asn.cymru.com", () => {
		expect(cymruOriginName("203.0.113.7")).toBe(
			"7.113.0.203.origin.asn.cymru.com",
		);
		expect(cymruOriginName("::ffff:203.0.113.7")).toBe(
			"7.113.0.203.origin.asn.cymru.com",
		);
	});

	test("an IPv6 address reverses its 32 nibbles under origin6.asn.cymru.com", () => {
		expect(cymruOriginName("2001:db8::1")).toBe(
			"1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.origin6.asn.cymru.com",
		);
	});

	test("anything else has no name", () => {
		expect(cymruOriginName("nope")).toBeNull();
	});

	test("an origin answer gives the AS, prefix, country and registry", () => {
		expect(
			parseCymruOrigin(
				"64500 64501 | 203.0.113.0/24 | NL | ripencc | 2010-01-01",
			),
		).toEqual({
			asn: 64500,
			country: "NL",
			network: "203.0.113.0/24",
			registry: "ripencc",
		});
		expect(parseCymruOrigin(undefined)).toEqual({
			asn: null,
			country: null,
			network: null,
			registry: null,
		});
	});

	test("an AS answer gives its name", () => {
		expect(
			parseCymruAsName(
				"64500 | NL | ripencc | 2010-01-01 | EXAMPLE-AS - Example, NL",
			),
		).toBe("EXAMPLE-AS - Example, NL");
		expect(parseCymruAsName(undefined)).toBeNull();
	});
});

describe("parseRdap", () => {
	const vcard = (fn: string, email?: string) => [
		"vcard",
		[
			["version", {}, "text", "4.0"],
			["fn", {}, "text", fn],
			...(email ? [["email", {}, "text", email]] : []),
		],
	];

	test("reads the network, its owner and the abuse contact nested under it", () => {
		expect(
			parseRdap({
				country: "NL",
				entities: [
					{
						entities: [
							{
								roles: ["abuse"],
								vcardArray: vcard("Abuse", "abuse@example.net"),
							},
						],
						roles: ["registrant"],
						vcardArray: vcard("Example Hosting"),
					},
				],
				name: "EXAMPLE-NET",
			}),
		).toEqual({
			abuseEmail: "abuse@example.net",
			country: "NL",
			networkName: "EXAMPLE-NET",
			org: "Example Hosting",
		});
	});

	test("a missing or malformed answer gives nothing", () => {
		expect(parseRdap(null)).toEqual({
			abuseEmail: null,
			country: null,
			networkName: null,
			org: null,
		});
		expect(
			parseRdap({ entities: [{ roles: ["abuse"] }] }).abuseEmail,
		).toBeNull();
	});
});

describe("intelSummary", () => {
	test("joins what's known and drops an owner the AS name already says", () => {
		expect(
			intelSummary({
				abuseEmail: null,
				asName: "EXAMPLE-AS - Example Hosting, NL",
				asn: 64500,
				country: "NL",
				hostname: null,
				lookedUpAt: "2026-10-05T12:00:00Z",
				network: null,
				networkName: null,
				org: "Example Hosting",
				registry: null,
			}),
		).toBe("AS64500 EXAMPLE-AS - Example Hosting, NL · NL");
		expect(intelSummary(null)).toBeNull();
	});
});
