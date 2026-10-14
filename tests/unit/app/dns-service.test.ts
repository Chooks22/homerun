import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { stubDomainOwners } from "../support/domain-owners";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { StatusPageDTO } = await import("../../../src/lib/dto/status-page-dto");
const { Logger } = await import("../../../src/lib/logger");
const { DomainDnsService } = await import(
	"../../../src/lib/services/domain-dns.service"
);
const { PangolinService } = await import(
	"../../../src/lib/services/pangolin.service"
);
const {
	deleteDns,
	markStaleServiceDns,
	releaseStaleServiceDns,
	serviceHostname,
	syncCoreHostDns,
	syncDashboardDns,
	syncDns,
} = await import("../../../src/lib/services/dns.service");

type Verdict =
	| { detail: string; ok: boolean; provider: string }
	| null
	| Error
	| string;

const calls: unknown[][] = [];
const logs: string[] = [];
let cloudflare: (hostname: string) => Verdict = () => null;
let pangolin: (hostname: string) => Verdict = () => null;
const originalBaseDomain = config.baseDomain;
const originalOrigin = config.auth.origin;
const originalSubdomain = config.serviceSubdomain;

function settle(verdict: Verdict) {
	return verdict instanceof Error || typeof verdict === "string"
		? Promise.reject(verdict)
		: Promise.resolve(verdict);
}

beforeEach(() => {
	calls.length = 0;
	logs.length = 0;
	cloudflare = () => null;
	pangolin = () => null;
	config.baseDomain = "example.com";
	config.auth.origin = "https://homerun.example.com";
	stub(InstanceSettingsDTO, "get", async () => ({
		toJSON: () => ({
			garagePublicHost: "s3.example.com",
			registryPublicHost: "registry.example.com",
		}),
	}));
	stub(StatusPageDTO, "list", async () => [
		{ domains: ["status.example.com"], name: "Status" },
	]);
	stub(DomainDnsService, "syncHostname", (host: string) => {
		calls.push(["cloudflare.sync", host, "example.com"]);
		return settle(cloudflare(host));
	});
	stub(DomainDnsService, "deleteHostname", (host: string) => {
		calls.push(["cloudflare.delete", host, "example.com"]);
		return settle(cloudflare(host));
	});
	stub(PangolinService, "syncDnsRecord", (host: string, opts: unknown) => {
		calls.push(["pangolin.sync", host, opts]);
		return settle(pangolin(host));
	});
	stub(PangolinService, "deleteDnsRecord", (host: string) => {
		calls.push(["pangolin.delete", host]);
		return settle(pangolin(host));
	});
	stub(Logger.prototype, "info", (message: string) => {
		logs.push(`info:${message}`);
	});
	stub(Logger.prototype, "warn", (message: string) => {
		logs.push(`warn:${message}`);
	});
});

afterEach(() => {
	config.baseDomain = originalBaseDomain;
	config.auth.origin = originalOrigin;
	config.serviceSubdomain = originalSubdomain;
	restoreStubs();
});

describe("serviceHostname", () => {
	test("prefixes the stack slug when there is one", () => {
		expect(serviceHostname("web", "shop")).toBe("shop-web.example.com");
		expect(serviceHostname("web", null)).toBe("web.example.com");
		expect(serviceHostname("web", undefined)).toBe("web.example.com");
		expect(serviceHostname("web", "")).toBe("web.example.com");
	});
});

describe("syncDns / deleteDns", () => {
	test("no configured provider means an empty result", async () => {
		expect(await syncDns(["a.example.com"])).toEqual([]);
		expect(calls).toEqual([
			["cloudflare.sync", "a.example.com", "example.com"],
			["pangolin.sync", "a.example.com", {}],
		]);
	});

	test("runs every provider over every hostname and prefixes each detail with the hostname", async () => {
		cloudflare = () => ({
			detail: "record created",
			ok: true,
			provider: "cloudflare",
		});
		pangolin = (host) =>
			host === "b.example.com"
				? { detail: "resource exists", ok: true, provider: "pangolin" }
				: null;

		const results = await syncDns(["a.example.com", "b.example.com"], {
			sso: true,
		});

		expect(results).toEqual([
			{
				detail: "a.example.com: record created",
				ok: true,
				provider: "cloudflare",
			},
			{
				detail: "b.example.com: record created",
				ok: true,
				provider: "cloudflare",
			},
			{
				detail: "b.example.com: resource exists",
				ok: true,
				provider: "pangolin",
			},
		]);
		expect(calls).toContainEqual([
			"pangolin.sync",
			"a.example.com",
			{ sso: true },
		]);
	});

	test("a rejecting provider is reported as a failure, not dropped", async () => {
		cloudflare = () => new Error("zone not found");
		pangolin = () => "api down";

		expect(await deleteDns(["x.example.com"])).toEqual([
			{
				detail: "x.example.com: zone not found",
				ok: false,
				provider: "dns",
			},
			{ detail: "x.example.com: api down", ok: false, provider: "pangolin" },
		]);
		expect(calls).toEqual([
			["cloudflare.delete", "x.example.com", "example.com"],
			["pangolin.delete", "x.example.com"],
		]);
	});

	test("never deletes the dashboard's host, a core service's public host or a status page domain", async () => {
		expect(
			await deleteDns([
				"HOMERUN.example.com",
				"registry.example.com",
				"s3.example.com",
				"status.example.com",
				"app.example.com",
			]),
		).toEqual([]);
		expect(calls).toEqual([
			["cloudflare.delete", "app.example.com", "example.com"],
			["pangolin.delete", "app.example.com"],
		]);
		expect(logs).toContain(
			"warn:Kept the DNS record of HOMERUN.example.com: it belongs to the Homerun dashboard",
		);
		expect(logs).toContain(
			'warn:Kept the DNS record of status.example.com: it belongs to the status page "Status"',
		);
	});

	test("no hostnames means no provider calls", async () => {
		expect(await deleteDns([])).toEqual([]);
		expect(calls).toEqual([]);
	});
});

describe("syncDashboardDns", () => {
	test("syncs the dashboard host without SSO and logs each provider's outcome", async () => {
		config.auth.origin = "https://homerun.example.com";
		cloudflare = () => ({
			detail: "updated",
			ok: true,
			provider: "cloudflare",
		});
		pangolin = () => ({ detail: "forbidden", ok: false, provider: "pangolin" });

		await syncDashboardDns();

		expect(calls).toEqual([
			["cloudflare.sync", "homerun.example.com", "example.com"],
			["pangolin.sync", "homerun.example.com", { sso: false }],
		]);
		expect(logs).toEqual([
			"info:Dashboard (cloudflare): homerun.example.com: updated",
			"warn:Dashboard sync failed (pangolin): homerun.example.com: forbidden",
		]);
	});

	test("skips a missing origin, a bare IP, a dotless host and a non-default port", async () => {
		for (const origin of [
			undefined,
			"http://192.168.1.10",
			"http://localhost",
			"https://homerun.example.com:8443",
			"not a url",
		]) {
			config.auth.origin = origin;
			await syncDashboardDns();
		}

		expect(calls).toEqual([]);
		expect(logs).toEqual([]);
	});
});

describe("syncCoreHostDns", () => {
	test("routes the new host without SSO and removes the one it replaced", async () => {
		await syncCoreHostDns(
			"Registry",
			"old-registry.example.com",
			"registry.example.com",
		);
		expect(calls).toContainEqual([
			"pangolin.sync",
			"registry.example.com",
			{ sso: false },
		]);
		expect(calls).toContainEqual([
			"pangolin.delete",
			"old-registry.example.com",
		]);
	});

	test("keeps the host it re-asserts", async () => {
		await syncCoreHostDns("Registry", null, "registry.example.com");
		expect(calls.some((call) => String(call[0]).endsWith(".delete"))).toBe(
			false,
		);
	});
});

function staleService(
	id: string,
	row: {
		defaultDomainEnabled?: boolean;
		dnsResolvable?: boolean;
		domains?: string[];
		stackId?: string | null;
		staleDnsHosts?: string[];
	} = {},
) {
	const state = {
		defaultDomainEnabled: true,
		dnsResolvable: true,
		domains: [] as string[],
		slug: id,
		stackId: null as string | null,
		staleDnsHosts: [] as string[],
		...row,
	};
	const updates: Record<string, unknown>[] = [];
	return {
		get dnsResolvable() {
			return state.dnsResolvable;
		},
		id,
		name: id,
		toJSON: () => ({ ...state }),
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
			Object.assign(state, patch);
		},
		updates,
	};
}

type StaleArg = Parameters<typeof releaseStaleServiceDns>[0];

describe("markStaleServiceDns", () => {
	test("records each routed service's old default hostname, and drops one the change brings back", async () => {
		config.serviceSubdomain = "apps";
		const web = staleService("web");
		const api = staleService("api", {
			stackId: "s1",
			staleDnsHosts: ["shop-api.apps.example.com", "shop-api.v1.example.com"],
		});
		const off = staleService("off", { defaultDomainEnabled: false });
		const internal = staleService("internal", { dnsResolvable: false });
		stub(ServiceDTO, "list", async () => [web, api, off, internal]);
		stub(StackDTO, "list", async () => [
			{ id: "s1", toJSON: () => ({ slug: "shop" }) },
		]);
		await markStaleServiceDns("example.com");
		expect(web.updates).toEqual([{ staleDnsHosts: ["web.example.com"] }]);
		expect(api.updates).toEqual([
			{ staleDnsHosts: ["shop-api.v1.example.com", "shop-api.example.com"] },
		]);
		expect(off.updates).toEqual([]);
		expect(internal.updates).toEqual([]);
	});

	test("does nothing when the services domain didn't move", async () => {
		let listed = false;
		stub(ServiceDTO, "list", async () => {
			listed = true;
			return [];
		});
		await markStaleServiceDns("example.com");
		expect(listed).toBe(false);
	});
});

describe("releaseStaleServiceDns", () => {
	test("deletes the old hostnames nothing routes any more and empties the list", async () => {
		const owners = await stubDomainOwners();
		owners.services.push({ domains: ["kept.example.com/api"], id: "other" });
		owners.workstations.push("ide.example.com");
		pangolin = (host) =>
			host === "broken.example.com"
				? new Error("down")
				: { detail: "deleted", ok: true, provider: "pangolin" };
		const svc = staleService("web", {
			staleDnsHosts: [
				"web.example.com",
				"kept.example.com",
				"ide.example.com",
				"broken.example.com",
				"homerun.example.com",
			],
		});
		await releaseStaleServiceDns(svc as unknown as StaleArg);
		expect(svc.updates).toEqual([{ staleDnsHosts: [] }]);
		expect(
			calls
				.filter((call) => call[0] === "pangolin.delete")
				.map((call) => call[1]),
		).toEqual(["web.example.com", "broken.example.com"]);
		expect(logs).toContain(
			"info:Old service hostname (pangolin): web.example.com: deleted",
		);
		expect(logs).toContain(
			"warn:Old service hostname deletion failed (pangolin): broken.example.com: down",
		);
	});

	test("does nothing for a service with no old hostname", async () => {
		const svc = staleService("web");
		await releaseStaleServiceDns(svc as unknown as StaleArg);
		expect(svc.updates).toEqual([]);
		expect(calls).toEqual([]);
	});
});
