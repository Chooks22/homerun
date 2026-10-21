import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	PATH_PATTERN_PRESETS,
	parsePathPatterns,
	authPathsProblem,
	matchingPathPattern,
	pathFiltersChanged,
	pathPatternProblem,
	pathPatternRegex,
	pathPatternsProblem,
	pathPatternsRegex,
} = await import("../../../src/lib/path-patterns");
const {
	AUTH_PATHS_ROUTER_PRIORITY,
	BLOCKED_ROUTER_PRIORITY,
	buildContainerLabels,
	GATE_ROUTER_PRIORITY,
} = await import("../../../src/lib/services/docker/labels");
const { blockedProofToken, errorPagesConfig, validBlockedProof } = await import(
	"../../../src/lib/services/docker/error-pages"
);
const { REDIRECT_ROUTER_PRIORITY } = await import("../../../src/lib/redirects");

function matches(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) =>
		new RegExp(pathPatternRegex(pattern), "i").test(path),
	);
}

describe("path patterns", () => {
	test("a pattern matches whole segments anywhere in the path", () => {
		expect(matches("/.git", [".git"])).toBe(true);
		expect(matches("/.git/config", [".git"])).toBe(true);
		expect(matches("/repo/.git/HEAD", [".git"])).toBe(true);
		expect(matches("/.github/workflows", [".git"])).toBe(false);
		expect(matches("/.env", [".env"])).toBe(true);
		expect(matches("/.envrc", [".env"])).toBe(false);
		expect(matches("/.env.local", [".env.*"])).toBe(true);
	});

	test("a leading slash anchors the pattern at the root", () => {
		expect(matches("/admin/users", ["/admin"])).toBe(true);
		expect(matches("/blog/admin", ["/admin"])).toBe(false);
		expect(matches("/administrator", ["/admin"])).toBe(false);
		expect(matches("/administrator", ["/admin*"])).toBe(true);
	});

	test("* crosses slashes, ? is one character, and matching ignores case", () => {
		expect(matches("/backups/2026/db.sql", ["*.sql"])).toBe(true);
		expect(matches("/WP-ADMIN/install.php", ["wp-admin"])).toBe(true);
		expect(matches("/v1", ["/v?"])).toBe(true);
		expect(matches("/v10", ["/v?"])).toBe(false);
	});

	test("regex metacharacters in a pattern are literal", () => {
		expect(pathPatternRegex("a+b(c).php")).toBe(
			"(?:^|/)a\\+b\\(c\\)\\.php(?:/|$)",
		);
		expect(matches("/aab.php", ["a+b.php"])).toBe(false);
	});

	test("several patterns become one case-insensitive alternation for PathRegexp", () => {
		expect(pathPatternsRegex(["/admin", ".env"])).toBe(
			"(?i)^/admin(?:/|$)|(?:^|/)\\.env(?:/|$)",
		);
	});

	test("the textarea is split into trimmed, unique lines", () => {
		expect(parsePathPatterns(" .env \n\n.git\n.env\n")).toEqual([
			".env",
			".git",
		]);
	});

	test("unusable patterns are refused with a reason", () => {
		expect(pathPatternProblem(".env")).toBeNull();
		expect(pathPatternProblem("a b")).toContain("whitespace");
		expect(pathPatternProblem("a`b")).toContain("quote");
		expect(pathPatternProblem("a\u0001b")).toContain("whitespace");
		expect(pathPatternProblem("/*")).toContain("every path");
		expect(pathPatternProblem("x".repeat(201))).toContain("200 characters");
		expect(pathPatternsProblem(Array(101).fill(".env"))).toContain("100");
		expect(pathPatternsProblem([".env", "*"])).toContain("every path");
		expect(pathPatternsProblem([".env"])).toBeNull();
	});

	test("every preset pattern is valid", () => {
		for (const preset of PATH_PATTERN_PRESETS) {
			expect(pathPatternsProblem(preset.patterns)).toBeNull();
		}
		const sensitive = PATH_PATTERN_PRESETS.find(
			(preset) => preset.id === "sensitive",
		);
		expect(matches("/.git-credentials", sensitive?.patterns ?? [])).toBe(true);
		expect(matches("/static/app.js", sensitive?.patterns ?? [])).toBe(false);
	});

	test("a partial wall needs at least one pattern", () => {
		expect(authPathsProblem("only", [])).toContain("at least one");
		expect(authPathsProblem("except", [])).toContain("at least one");
		expect(authPathsProblem("all", [])).toBeNull();
		expect(authPathsProblem("only", ["/admin"])).toBeNull();
	});

	test("only a blocked-paths change, or a wall-paths change while the wall is on, needs new routers", () => {
		const base = {
			authPaths: [],
			authPathsMode: "all" as const,
			authRequired: true,
			blockedPaths: [".env"],
		};
		expect(pathFiltersChanged(base, base)).toBe(false);
		expect(pathFiltersChanged(base, { ...base, blockedPaths: [] })).toBe(true);
		expect(
			pathFiltersChanged(base, {
				...base,
				authPaths: ["/admin"],
				authPathsMode: "only",
			}),
		).toBe(true);
		expect(pathFiltersChanged(base, { ...base, authPathsMode: "except" })).toBe(
			false,
		);
		expect(
			pathFiltersChanged(
				{ ...base, authRequired: false },
				{
					...base,
					authPaths: ["/admin"],
					authPathsMode: "only",
					authRequired: false,
				},
			),
		).toBe(false);
	});
});

describe("matchingPathPattern", () => {
	test("names the first pattern a path falls under, query string ignored", () => {
		const patterns = ["/admin", ".env*", "*.sql"];
		expect(matchingPathPattern(patterns, "/admin/users?x=1")).toBe("/admin");
		expect(matchingPathPattern(patterns, "/app/.env.local")).toBe(".env*");
		expect(matchingPathPattern(patterns, "/backup/DUMP.SQL")).toBe("*.sql");
	});

	test("null when nothing matches or there's no path", () => {
		expect(matchingPathPattern(["/admin"], "/blog/admin")).toBeNull();
		expect(matchingPathPattern([".git"], "/.github")).toBeNull();
		expect(matchingPathPattern(["/admin"], null)).toBeNull();
		expect(matchingPathPattern([], "/admin")).toBeNull();
	});
});

describe("blocked paths routers", () => {
	const service = {
		containerPort: 80,
		defaultDomainEnabled: false,
		domains: ["app.example.org", "www.example.org"],
		serviceId: "svc-1",
		slug: "app",
	};

	test("each hostname gets a blocked router above the others, sent to the blocked page", () => {
		const labels = buildContainerLabels({
			...service,
			blockedPaths: [".env"],
			errorPages: true,
		});
		expect(labels["traefik.http.routers.app_blocked.rule"]).toBe(
			"Host(`app.example.org`) && PathRegexp(`(?i)(?:^|/)\\.env(?:/|$)`)",
		);
		expect(labels["traefik.http.routers.app_blocked.priority"]).toBe(
			String(BLOCKED_ROUTER_PRIORITY),
		);
		expect(labels["traefik.http.routers.app_blocked.service"]).toBe(
			"homerun-error-pages@file",
		);
		expect(labels["traefik.http.routers.app_blocked.middlewares"]).toBe(
			"homerun-blocked@file",
		);
		expect(labels["traefik.http.routers.app-1_blocked.rule"]).toContain(
			"Host(`www.example.org`)",
		);
		expect(labels["traefik.http.routers.app_blocked.tls"]).toBe("true");
		expect(Object.keys(labels).some((key) => key.includes("ipallowlist"))).toBe(
			false,
		);
	});

	test("without the error pages file Traefik denies blocked paths itself", () => {
		const labels = buildContainerLabels({
			...service,
			blockedPaths: [".env"],
		});
		expect(labels["traefik.http.routers.app_blocked.middlewares"]).toBe(
			"app_deny",
		);
		expect(labels["traefik.http.routers.app_blocked.service"]).toBe("app");
		expect(
			labels["traefik.http.middlewares.app_deny.ipallowlist.sourcerange"],
		).toBe("127.0.0.1/32");
	});

	test("no blocked paths, no blocked router", () => {
		const labels = buildContainerLabels(service);
		expect(Object.keys(labels).some((key) => key.includes("_blocked"))).toBe(
			false,
		);
	});

	test("the blocked page middleware rewrites the path and stamps Traefik's proof", () => {
		const yaml = errorPagesConfig({
			entrypoint: "websecure",
			proof: blockedProofToken("secret"),
			target: "http://app:3000",
		});
		expect(yaml).toContain(
			"homerun-blocked:\n      chain:\n        middlewares:\n          - homerun-blocked-page\n          - homerun-blocked-proof",
		);
		expect(yaml).toContain(
			"homerun-blocked-page:\n      replacePath:\n        path: /homerun-error/blocked",
		);
		expect(yaml).toContain(
			`customRequestHeaders:\n          X-Homerun-Blocked: "${blockedProofToken("secret")}"`,
		);
	});

	test("only the proof derived from the auth secret is accepted", () => {
		const proof = blockedProofToken("secret");
		expect(proof).toMatch(/^[0-9a-f]{64}$/);
		expect(blockedProofToken("other")).not.toBe(proof);
		expect(validBlockedProof(proof, "secret")).toBe(true);
		expect(validBlockedProof(proof, "other")).toBe(false);
		expect(validBlockedProof("forged", "secret")).toBe(false);
		expect(validBlockedProof(null, "secret")).toBe(false);
	});

	test("a slug ending in -blocked can't collide with another service's blocked router", () => {
		const labels = buildContainerLabels({
			...service,
			blockedPaths: [".env"],
		});
		const other = buildContainerLabels({
			...service,
			domains: ["shop.example.org"],
			slug: "app-blocked",
		});
		const routers = (set: Record<string, string>) =>
			Object.keys(set)
				.filter((key) => key.endsWith(".rule"))
				.map((key) => key.split(".")[3]);
		expect(routers(labels)).toContain("app_blocked");
		expect(routers(other)).toEqual(["app-blocked"]);
	});

	test("a redirect outranks every router a service gets", () => {
		expect(REDIRECT_ROUTER_PRIORITY).toBeGreaterThan(BLOCKED_ROUTER_PRIORITY);
	});
});

describe("login wall paths routers", () => {
	const gated = {
		authRequired: true,
		containerPort: 80,
		defaultDomainEnabled: false,
		domains: ["app.example.org"],
		serviceId: "svc-1",
		slug: "app",
	};

	test("only: the matching paths carry the wall, the rest is public, the callback stays gated", () => {
		const labels = buildContainerLabels({
			...gated,
			authPaths: ["/admin"],
			authPathsMode: "only",
		});
		expect(labels["traefik.http.routers.app.middlewares"]).toBe(
			"app_strip-identity,app-retry",
		);
		expect(labels["traefik.http.routers.app_paths.rule"]).toBe(
			"Host(`app.example.org`) && PathRegexp(`(?i)^/admin(?:/|$)`)",
		);
		expect(labels["traefik.http.routers.app_paths.middlewares"]).toBe(
			"app-auth,app-retry",
		);
		expect(labels["traefik.http.routers.app_paths.priority"]).toBe(
			String(AUTH_PATHS_ROUTER_PRIORITY),
		);
		expect(labels["traefik.http.routers.app_gate.rule"]).toBe(
			"Host(`app.example.org`) && (Path(`/__homerun_auth/callback`) || Path(`/__homerun_auth/logout`))",
		);
		expect(labels["traefik.http.routers.app_gate.middlewares"]).toBe(
			"app-auth,app-retry",
		);
		expect(labels["traefik.http.routers.app_gate.priority"]).toBe(
			String(GATE_ROUTER_PRIORITY),
		);
	});

	test("except: everything carries the wall but the matching paths", () => {
		const labels = buildContainerLabels({
			...gated,
			authPaths: ["/api"],
			authPathsMode: "except",
		});
		expect(labels["traefik.http.routers.app.middlewares"]).toBe(
			"app-auth,app-retry",
		);
		expect(labels["traefik.http.routers.app_paths.middlewares"]).toBe(
			"app_strip-identity,app-retry",
		);
		expect(labels["traefik.http.routers.app_gate.middlewares"]).toBe(
			"app-auth,app-retry",
		);
	});

	test("the public routers of a split wall blank the identity headers a visitor could forge", () => {
		const labels = buildContainerLabels({
			...gated,
			authPaths: ["/admin"],
			authPathsMode: "only",
		});
		for (const header of [
			"X-Homerun-User",
			"X-Homerun-Email",
			"X-Homerun-Name",
		]) {
			expect(
				labels[
					`traefik.http.middlewares.app_strip-identity.headers.customrequestheaders.${header}`
				],
			).toBe("");
		}
		expect(labels["traefik.http.routers.app_paths.middlewares"]).not.toContain(
			"strip",
		);
		expect(labels["traefik.http.routers.app_gate.middlewares"]).not.toContain(
			"strip",
		);
	});

	test("the wall is never split while it's off, or with no patterns", () => {
		for (const params of [
			{
				...gated,
				authPaths: ["/api"],
				authPathsMode: "except" as const,
				authRequired: false,
			},
			{ ...gated, authPaths: [], authPathsMode: "only" as const },
			{ ...gated, authPaths: ["/api"], authPathsMode: "all" as const },
		]) {
			const labels = buildContainerLabels(params);
			expect(
				Object.keys(labels).some(
					(key) =>
						key.includes("_paths") ||
						key.includes("_gate") ||
						key.includes("_strip-identity"),
				),
			).toBe(false);
		}
	});

	test("blocked paths win over a split wall", () => {
		const labels = buildContainerLabels({
			...gated,
			authPaths: ["/api"],
			authPathsMode: "except",
			blockedPaths: [".env"],
			errorPages: true,
		});
		expect(BLOCKED_ROUTER_PRIORITY).toBeGreaterThan(GATE_ROUTER_PRIORITY);
		expect(GATE_ROUTER_PRIORITY).toBeGreaterThan(AUTH_PATHS_ROUTER_PRIORITY);
		expect(labels["traefik.http.routers.app.middlewares"]).toBe(
			"homerun-errors@file,app-auth,app-retry",
		);
		expect(labels["traefik.http.routers.app_blocked.middlewares"]).toBe(
			"homerun-blocked@file",
		);
	});
});
