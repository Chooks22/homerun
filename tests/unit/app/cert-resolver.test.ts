import { describe, expect, test } from "bun:test";
import { setDnsChallengeDomains } from "../../../src/lib/config";
import { certResolverFor } from "../../../src/lib/services/docker/cert-resolver";

describe("certResolverFor", () => {
	test("uses the resolver for a real domain", () => {
		expect(certResolverFor("app.example.com", "letsencrypt", false)).toBe(
			"letsencrypt",
		);
	});

	test("skips hosts ACME can never issue for", () => {
		expect(certResolverFor("203.0.113.10", "letsencrypt", false)).toBeNull();
		expect(
			certResolverFor("app.203.0.113.10", "letsencrypt", false),
		).toBeNull();
		expect(certResolverFor("app.localhost", "letsencrypt", false)).toBeNull();
		expect(certResolverFor("app", "letsencrypt", false)).toBeNull();
	});

	test("skips every host when Pangolin fronts the instance, since its DNS points at Pangolin", () => {
		expect(certResolverFor("app.example.com", "letsencrypt", true)).toBeNull();
	});

	test("skips when no resolver is configured", () => {
		expect(certResolverFor("app.example.com", "", false)).toBeNull();
	});

	test("defers to the wildcard certificate of a DNS-challenge domain", () => {
		setDnsChallengeDomains(["example.com"]);
		try {
			expect(
				certResolverFor("app.example.com", "letsencrypt", false),
			).toBeNull();
			expect(certResolverFor("a.b.example.com", "letsencrypt", false)).toBe(
				"letsencrypt-dns",
			);
			expect(certResolverFor("app.other.org", "letsencrypt", false)).toBe(
				"letsencrypt",
			);
		} finally {
			setDnsChallengeDomains([]);
		}
	});
});
