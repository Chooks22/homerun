import { describe, expect, test } from "bun:test";
import {
	branchLabel,
	defaultHostname,
	domainHosts,
	isDnsLabel,
	isDomainEntry,
	isUnderDomain,
	normalizeDomains,
	previewDomainTemplateProblem,
	primaryHostname,
	renderPreviewDomain,
	rewriteHostnames,
	serviceHostnames,
	splitDomain,
} from "#lib/service-domains.js";

const base = "example.com";
const svc = {
	defaultDomainEnabled: true,
	domains: ["app.example.org", "www.example.org"],
	primaryDomain: null,
	slug: "app",
};

describe("service domains", () => {
	test("the default hostname carries the stack's slug", () => {
		expect(defaultHostname("app", null, base)).toBe("app.example.com");
		expect(defaultHostname("app", "shop", base)).toBe("shop-app.example.com");
		expect(defaultHostname("shop-app", "shop", base)).toBe(
			"shop-app.example.com",
		);
	});

	test("routes the default hostname first, then the service's own domains", () => {
		expect(serviceHostnames(svc, null, base)).toEqual([
			"app.example.com",
			"app.example.org",
			"www.example.org",
		]);
		expect(
			serviceHostnames({ ...svc, defaultDomainEnabled: false }, null, base),
		).toEqual(["app.example.org", "www.example.org"]);
	});

	test("the main domain is the chosen one while it's still routed", () => {
		expect(
			primaryHostname({ ...svc, primaryDomain: "www.example.org" }, null, base),
		).toBe("www.example.org");
		expect(
			primaryHostname(
				{ ...svc, primaryDomain: "gone.example.org" },
				null,
				base,
			),
		).toBe("app.example.com");
		expect(
			primaryHostname(
				{ ...svc, defaultDomainEnabled: false, domains: [] },
				null,
				base,
			),
		).toBeNull();
	});

	test("a subdomain of the base domain is under it, a lookalike isn't", () => {
		expect(isUnderDomain("drive.example.com", base)).toBe(true);
		expect(isUnderDomain("example.com", base)).toBe(true);
		expect(isUnderDomain("badexample.com", base)).toBe(false);
	});

	test("normalizing trims, lowercases and drops blanks and duplicates", () => {
		expect(
			normalizeDomains([" A.example.org", "", "a.example.org", "b.io"]),
		).toEqual(["a.example.org", "b.io"]);
	});

	test("a branch becomes one DNS label", () => {
		expect(branchLabel("Feat/Login_Page")).toBe("feat-login-page");
		expect(branchLabel("--x--")).toBe("x");
		expect(branchLabel("///")).toBe("branch");
		expect(branchLabel("a".repeat(70))).toHaveLength(63);
	});

	test("a preview domain template fills in the pull request", () => {
		const values = { branch: "feat/login", pr: 42, slug: "web" };
		expect(renderPreviewDomain("pr-{pr}.example.com", values)).toBe(
			"pr-42.example.com",
		);
		expect(renderPreviewDomain(" {Branch}.{slug}.Example.com ", values)).toBe(
			"feat-login.web.example.com",
		);
		expect(
			renderPreviewDomain("{branch}.example.com", { ...values, branch: null }),
		).toBe("pr-42.example.com");
		expect(renderPreviewDomain("  ", values)).toBeNull();
	});

	test("a template must vary per preview and render a valid domain", () => {
		expect(previewDomainTemplateProblem("pr-{pr}.example.com")).toBeNull();
		expect(previewDomainTemplateProblem("{branch}.preview.io")).toBeNull();
		expect(previewDomainTemplateProblem("preview.example.com")).toContain(
			"{pr} or {branch}",
		);
		expect(previewDomainTemplateProblem("pr-{pr}")).toContain(
			"doesn't make a valid domain",
		);
	});

	test("a preview's env points at its own hostname, not its parent's", () => {
		expect(
			rewriteHostnames(
				{
					API: "https://api.sergios.fr",
					ORIGIN: "https://sergios.fr",
					OTHER: "https://www.sergios.fr/x",
					PORT: "3000",
				},
				["sergios.fr", "www.sergios.fr"],
				"preview-4.sergios.fr",
			),
		).toEqual({
			API: "https://api.sergios.fr",
			ORIGIN: "https://preview-4.sergios.fr",
			OTHER: "https://preview-4.sergios.fr/x",
			PORT: "3000",
		});
		expect(rewriteHostnames({ A: "sergios.fr" }, ["sergios.fr"], null)).toEqual(
			{
				A: "sergios.fr",
			},
		);
	});
});

describe("domains with a path", () => {
	test("splits an entry into its host and path prefix", () => {
		expect(splitDomain("example.com")).toEqual({
			host: "example.com",
			path: "",
		});
		expect(splitDomain("example.com/api/v2")).toEqual({
			host: "example.com",
			path: "/api/v2",
		});
	});

	test("accepts a domain with a path and refuses what would break a Traefik rule", () => {
		expect(isDomainEntry("example.com")).toBe(true);
		expect(isDomainEntry("example.com/api")).toBe(true);
		expect(isDomainEntry("example.com/api/v2")).toBe(true);
		expect(isDomainEntry("example.com/")).toBe(false);
		expect(isDomainEntry("example.com//api")).toBe(false);
		expect(isDomainEntry("example.com/a`b")).toBe(false);
		expect(isDomainEntry("example.com/a b")).toBe(false);
		expect(isDomainEntry("example.com/api?x=1")).toBe(false);
		expect(isDomainEntry("nope/api")).toBe(false);
	});

	test("normalizes away a trailing slash", () => {
		expect(normalizeDomains([" Example.com/API/ ", "example.com/api"])).toEqual(
			["example.com/api"],
		);
	});

	test("one host per distinct hostname, paths folded in", () => {
		expect(
			domainHosts(["example.com", "example.com/api", "api.example.com"]),
		).toEqual(["example.com", "api.example.com"]);
	});
});

describe("isDnsLabel", () => {
	test("takes one label of letters, digits and inner dashes", () => {
		for (const label of ["apps", "a", "eu-1", "x".repeat(63)]) {
			expect(isDnsLabel(label)).toBe(true);
		}
		for (const label of [
			"apps.eu",
			"-apps",
			"apps-",
			"apps_1",
			"a b",
			"",
			"x".repeat(64),
			"Apps",
		]) {
			expect(isDnsLabel(label)).toBe(false);
		}
	});
});
