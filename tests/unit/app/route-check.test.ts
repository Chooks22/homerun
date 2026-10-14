import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { routeSpec } = await import(
	"../../../src/lib/services/deploy/route-check"
);

const original = {
	certResolver: config.traefik.certResolver,
	entrypoint: config.traefik.entrypoint,
	pangolinEnabled: config.pangolinEnabled,
};

afterEach(() => {
	config.traefik.certResolver = original.certResolver;
	config.traefik.entrypoint = original.entrypoint;
	config.pangolinEnabled = original.pangolinEnabled;
});

function service(overrides: Record<string, unknown> = {}) {
	return {
		containerPort: 3000,
		defaultDomainEnabled: false,
		domainPorts: { "api.example.org": 8080 },
		domains: ["app.example.org", "api.example.org", "example.org/docs"],
		image: "nginx",
		portProtocol: "tcp",
		primaryDomain: null,
		slug: "web",
		...overrides,
	};
}

describe("routeSpec", () => {
	test("lists every routed host with its path, port, resolver and public flag", () => {
		config.traefik.certResolver = "letsencrypt";
		config.traefik.entrypoint = "websecure";
		config.pangolinEnabled = false;
		const spec = routeSpec({
			errorPages: true,
			publicHosts: new Set(["app.example.org"]),
			routed: true,
			stackSlug: null,
			svc: service(),
		});
		expect(spec).toEqual({
			entrypoint: "websecure",
			errorPages: true,
			hosts: [
				{
					certResolver: true,
					host: "app.example.org",
					path: "",
					port: 3000,
					public: true,
				},
				{
					certResolver: true,
					host: "api.example.org",
					path: "",
					port: 8080,
					public: false,
				},
				{
					certResolver: true,
					host: "example.org",
					path: "/docs",
					port: 3000,
					public: false,
				},
			],
		});
	});

	test("behind Pangolin the local Traefik issues no certificate", () => {
		config.traefik.certResolver = "letsencrypt";
		config.pangolinEnabled = true;
		const spec = routeSpec({
			errorPages: false,
			publicHosts: new Set(),
			routed: true,
			stackSlug: null,
			svc: service({ domains: ["app.example.org"] }),
		});
		expect(spec?.hosts.map((host) => host.certResolver)).toEqual([false]);
	});

	test("nothing to check when the service isn't routed, is UDP-only, is a database or has no host", () => {
		const base = {
			errorPages: false,
			publicHosts: new Set<string>(),
			stackSlug: null,
		};
		expect(routeSpec({ ...base, routed: false, svc: service() })).toBeNull();
		expect(
			routeSpec({
				...base,
				routed: true,
				svc: service({ portProtocol: "udp" }),
			}),
		).toBeNull();
		expect(
			routeSpec({
				...base,
				routed: true,
				svc: service({ image: "postgres" }),
			}),
		).toBeNull();
		expect(
			routeSpec({ ...base, routed: true, svc: service({ domains: [] }) }),
		).toBeNull();
	});
});
