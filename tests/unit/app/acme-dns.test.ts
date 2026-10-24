import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
	acmeDnsPassword,
	acmeWildcardRouterConfig,
	applyEnv,
	challengeDomainFor,
	dnsChallengeFlags,
	dnsChallengeSetup,
	httpreqEnv,
	wildcardNames,
} from "../../../src/lib/acme-dns";

describe("challengeDomainFor", () => {
	test("picks the most specific domain covering the name", () => {
		expect(
			challengeDomainFor("_acme-challenge.app.lab.example.com.", [
				"example.com",
				"lab.example.com",
			]),
		).toBe("lab.example.com");
	});

	test("is null outside every domain, a lookalike suffix included", () => {
		expect(
			challengeDomainFor("app.notexample.com", ["example.com"]),
		).toBeNull();
	});
});

describe("wildcardNames", () => {
	test("covers the domain and its first-level subdomains", () => {
		expect(wildcardNames("example.com", "example.com")).toEqual([
			"example.com",
			"*.example.com",
		]);
	});

	test("adds the services subdomain's wildcard when it sits below the domain", () => {
		expect(wildcardNames("example.com", "apps.example.com")).toEqual([
			"example.com",
			"*.example.com",
			"*.apps.example.com",
		]);
	});
});

describe("dnsChallengeSetup", () => {
	test("points at the app's origin Traefik already reaches for forwardAuth", () => {
		expect(
			dnsChallengeSetup("http://homerun-auth:3000/api/v1/auth-check", "s3cret"),
		).toEqual({
			endpoint: "http://homerun-auth:3000/api/acme-dns",
			password: acmeDnsPassword("s3cret"),
			username: "homerun",
		});
	});

	test("is null for a URL that doesn't parse", () => {
		expect(dnsChallengeSetup("not a url", "s3cret")).toBeNull();
	});

	test("derives a stable password that changes with the secret", () => {
		expect(acmeDnsPassword("a")).toBe(acmeDnsPassword("a"));
		expect(acmeDnsPassword("a")).not.toBe(acmeDnsPassword("b"));
	});
});

describe("dnsChallengeFlags", () => {
	const cmd = [
		"--certificatesresolvers.letsencrypt.acme.httpchallenge=true",
		"--certificatesresolvers.letsencrypt.acme.email=ops@example.com",
		"--certificatesresolvers.letsencrypt.acme.storage=/certs/acme.json",
	];

	test("shares the HTTP-01 resolver's storage and email", () => {
		expect(dnsChallengeFlags("letsencrypt", true, cmd, null)).toEqual({
			"certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider":
				"httpreq",
			"certificatesresolvers.letsencrypt-dns.acme.dnschallenge.resolvers":
				"1.1.1.1:53,8.8.8.8:53",
			"certificatesresolvers.letsencrypt-dns.acme.email": "ops@example.com",
			"certificatesresolvers.letsencrypt-dns.acme.storage": "/certs/acme.json",
		});
	});

	test("prefers the email set in the settings", () => {
		expect(
			dnsChallengeFlags("letsencrypt", true, cmd, "me@example.org")[
				"certificatesresolvers.letsencrypt-dns.acme.email"
			],
		).toBe("me@example.org");
	});

	test("nulls every flag when turned off", () => {
		expect(
			Object.values(dnsChallengeFlags("letsencrypt", false, cmd, null)),
		).toEqual([null, null, null, null]);
	});
});

describe("applyEnv", () => {
	test("sets, replaces and removes variables, keeping the rest in place", () => {
		expect(
			applyEnv(["PATH=/bin", "HTTPREQ_ENDPOINT=old", "HTTPREQ_USERNAME=x"], {
				HTTPREQ_ENDPOINT: "new",
				HTTPREQ_PASSWORD: "p",
				HTTPREQ_USERNAME: null,
			}),
		).toEqual(["PATH=/bin", "HTTPREQ_ENDPOINT=new", "HTTPREQ_PASSWORD=p"]);
	});

	test("leaves an environment that already matches unchanged", () => {
		const env = applyEnv([], httpreqEnv(dnsChallengeSetup("http://a:1", "s")));
		expect(
			applyEnv(env, httpreqEnv(dnsChallengeSetup("http://a:1", "s"))),
		).toEqual(env);
	});
});

describe("acmeWildcardRouterConfig", () => {
	test("asks the DNS-01 resolver for each domain's wildcard", () => {
		const yaml = acmeWildcardRouterConfig({
			domains: ["example.com"],
			entrypoint: "websecure",
			serviceDomain: "apps.example.com",
		});
		expect(parse(yaml ?? "")).toEqual({
			http: {
				routers: {
					"homerun-acme-wildcard-example-com": {
						entryPoints: ["websecure"],
						rule: "Host(`_acme-wildcard.example.com`)",
						service: "noop@internal",
						tls: {
							certResolver: "letsencrypt-dns",
							domains: [
								{
									main: "example.com",
									sans: ["*.example.com", "*.apps.example.com"],
								},
							],
						},
					},
				},
			},
		});
	});

	test("is null with no domain", () => {
		expect(
			acmeWildcardRouterConfig({
				domains: [],
				entrypoint: "websecure",
				serviceDomain: "example.com",
			}),
		).toBeNull();
	});
});
