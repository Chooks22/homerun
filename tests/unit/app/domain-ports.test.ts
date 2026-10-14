import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { buildContainerLabels } = await import(
	"../../../src/lib/services/docker/labels"
);
const { config } = await import("../../../src/lib/config");

describe("per-domain container ports", () => {
	const labels = buildContainerLabels({
		containerPort: 3000,
		domainPorts: { "api.example.org": 8080 },
		domains: ["git.example.org", "api.example.org"],
		serviceId: "svc-1",
		slug: "gitea",
	});

	test("a domain without an override stays on the containerPort service", () => {
		expect(labels["traefik.http.routers.gitea-1.service"]).toBe("gitea");
		expect(labels["traefik.http.services.gitea.loadbalancer.server.port"]).toBe(
			"3000",
		);
	});

	test("an overridden domain gets its own service on its port", () => {
		expect(labels["traefik.http.routers.gitea-2.rule"]).toBe(
			"Host(`api.example.org`)",
		);
		expect(labels["traefik.http.routers.gitea-2.service"]).toBe("gitea-8080");
		expect(
			labels["traefik.http.services.gitea-8080.loadbalancer.server.port"],
		).toBe("8080");
	});
});

describe("response cache middleware", () => {
	const build = (httpCacheTtl: number | null) =>
		buildContainerLabels({
			authRequired: true,
			containerPort: 80,
			domains: ["app.example.org"],
			httpCacheTtl,
			serviceId: "svc-1",
			slug: "app",
		});

	test("adds a per-session Souin cache after auth and retry when the plugin is on", () => {
		config.traefik.httpCache = true;
		const labels = build(120);
		expect(labels["traefik.http.routers.app.middlewares"]).toBe(
			"app-auth,app-retry,app_unconditional,app-cache",
		);
		for (const header of ["If-None-Match", "If-Modified-Since"]) {
			expect(
				labels[
					`traefik.http.middlewares.app_unconditional.headers.customrequestheaders.${header}`
				],
			).toBe("");
		}
		expect(
			labels[
				"traefik.http.middlewares.app-cache.plugin.souin.default_cache.ttl"
			],
		).toBe("120s");
		expect(
			labels[
				"traefik.http.middlewares.app-cache.plugin.souin.default_cache.key.headers[0]"
			],
		).toBe("Cookie");
		expect(
			labels[
				"traefik.http.middlewares.app-cache.plugin.souin.default_cache.key.headers[1]"
			],
		).toBe("Authorization");
	});

	test("adds nothing when the service or the instance has caching off", () => {
		config.traefik.httpCache = true;
		expect(build(null)["traefik.http.routers.app.middlewares"]).toBe(
			"app-auth,app-retry",
		);
		config.traefik.httpCache = false;
		const labels = build(120);
		expect(labels["traefik.http.routers.app.middlewares"]).toBe(
			"app-auth,app-retry",
		);
		expect(
			Object.keys(labels).some(
				(k) => k.includes("souin") || k.includes("_unconditional"),
			),
		).toBe(false);
	});
});

describe("domains with a path", () => {
	const labels = buildContainerLabels({
		containerPort: 3000,
		domains: ["www.example.org/api", "www.example.org/docs"],
		serviceId: "svc-1",
		slug: "api",
		stripPathDomains: ["www.example.org/api"],
	});

	test("routes only the path and what's under it", () => {
		expect(labels["traefik.http.routers.api-1.rule"]).toBe(
			"Host(`www.example.org`) && (Path(`/api`) || PathPrefix(`/api/`))",
		);
	});

	test("strips the prefix last in the chain when asked", () => {
		expect(labels["traefik.http.routers.api-1.middlewares"]).toBe(
			"api-retry,api-1_stripprefix",
		);
		expect(
			labels["traefik.http.middlewares.api-1_stripprefix.stripprefix.prefixes"],
		).toBe("/api");
	});

	test("keeps the prefix otherwise", () => {
		expect(labels["traefik.http.routers.api-2.middlewares"]).toBe("api-retry");
		expect(
			Object.keys(labels).some((key) => key.includes("api-2_stripprefix")),
		).toBe(false);
	});
});

describe("login wall on a domain with a path", () => {
	const labels = buildContainerLabels({
		authPaths: ["/admin/*"],
		authPathsMode: "only",
		authRequired: true,
		containerPort: 3000,
		defaultDomainEnabled: false,
		domains: ["www.example.org/api"],
		serviceId: "svc-1",
		slug: "api",
	});

	test("keeps the callback and logout under the path, where the service is routed", () => {
		expect(labels["traefik.http.routers.api_gate.rule"]).toBe(
			"Host(`www.example.org`) && (Path(`/api`) || PathPrefix(`/api/`)) && (Path(`/api/__homerun_auth/callback`) || Path(`/api/__homerun_auth/logout`))",
		);
	});
});
