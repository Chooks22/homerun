import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { RedirectDTO } = await import("../../../src/lib/dto/redirect-dto");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { StatusPageDTO } = await import("../../../src/lib/dto/status-page-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { DomainDnsService } = await import(
	"../../../src/lib/services/domain-dns.service"
);
const { PangolinService } = await import(
	"../../../src/lib/services/pangolin.service"
);
const { RedirectService } = await import(
	"../../../src/lib/services/redirect.service"
);
const { DomainConflictError, ServiceSettingsService } = await import(
	"../../../src/lib/services/service-settings.service"
);

type Row = Record<string, unknown> & {
	defaultDomainEnabled: boolean;
	domains: string[];
	slug: string;
};

const actor = { hostAccess: true, userId: "u1" };
const updates: [string, Record<string, unknown>][] = [];
const disabledRedirects: string[] = [];
const redeployed: string[] = [];
let redirectSyncs = 0;
let services: ReturnType<typeof fakeService>[] = [];
const originalOrigin = config.auth.origin;
const originalBase = config.baseDomain;

function fakeService(id: string, row: Partial<Row>) {
	const state: Row = {
		authPaths: [],
		authPathsMode: "all",
		authRequired: false,
		blockedPaths: [],
		containerPort: 80,
		defaultDomainEnabled: true,
		dnsResolvable: true,
		domainPorts: {},
		domains: [],
		primaryDomain: null,
		slug: id,
		stackId: null,
		stripPathDomains: [],
		...row,
	};
	return {
		get dnsResolvable() {
			return state.dnsResolvable as boolean;
		},
		id,
		name: id.toUpperCase(),
		get slug() {
			return state.slug;
		},
		get stackId() {
			return null;
		},
		toJSON: () => ({ ...state }),
		update: async (patch: Record<string, unknown>) => {
			updates.push([id, patch]);
			Object.assign(state, patch);
		},
	};
}

function apply(
	svc: ReturnType<typeof fakeService>,
	input: Record<string, unknown>,
) {
	return ServiceSettingsService.apply(
		svc as unknown as Parameters<typeof ServiceSettingsService.apply>[0],
		input as Parameters<typeof ServiceSettingsService.apply>[1],
		actor,
	);
}

beforeEach(() => {
	updates.length = 0;
	disabledRedirects.length = 0;
	redeployed.length = 0;
	redirectSyncs = 0;
	config.auth.origin = "https://homerun.example.com";
	config.baseDomain = "example.com";
	services = [
		fakeService("old", { domains: ["app.example.org", "example.org/api"] }),
		fakeService("solo", {}),
	];
	stub(ServiceDTO, "list", async () => services);
	stub(ServiceDTO, "slugTaken", async () => false);
	stub(ServiceDTO, "get", async (id: string) =>
		services.find((svc) => svc.id === id),
	);
	stub(StackDTO, "list", async () => []);
	stub(StackDTO, "get", async () => null);
	stub(WorkstationDTO, "listAll", async () => [
		{
			id: "w1",
			toJSON: () => ({ domain: "ide.dev.example.com", slug: "ide" }),
		},
	]);
	stub(RedirectDTO, "list", async () => [
		{
			toJSON: () => ({ enabled: true, id: "r1", source: "go.example.org/x" }),
		},
	]);
	stub(RedirectDTO, "get", async (id: string) => ({
		setEnabled: async (enabled: boolean) => {
			if (!enabled) {
				disabledRedirects.push(id);
			}
		},
	}));
	stub(RedirectService, "sync", async () => {
		redirectSyncs += 1;
	});
	stub(InstanceSettingsDTO, "get", async () => ({
		toJSON: () => ({ registryPublicHost: "registry.example.com" }),
	}));
	stub(StatusPageDTO, "list", async () => []);
	stub(DeploymentService, "redeployForRouting", async (svc: { id: string }) => {
		redeployed.push(svc.id);
		return true;
	});
	stub(DeploymentService, "redeployIfLoginWallChanged", async () => false);
	stub(DomainDnsService, "syncHostname", async () => null);
	stub(DomainDnsService, "deleteHostname", async () => null);
	stub(PangolinService, "syncDnsRecord", async () => null);
	stub(PangolinService, "deleteDnsRecord", async () => null);
	stub(Logger.prototype, "info", () => {});
});

afterEach(() => {
	restoreStubs();
	config.auth.origin = originalOrigin;
	config.baseDomain = originalBase;
});

describe("service domain conflicts", () => {
	test("a domain another service routes is refused with an offer to take it over", async () => {
		const svc = fakeService("new", {});
		const error = await apply(svc, { domains: ["app.example.org"] }).catch(
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(DomainConflictError);
		expect((error as InstanceType<typeof DomainConflictError>).status).toBe(
			409,
		);
		expect((error as InstanceType<typeof DomainConflictError>).message).toBe(
			'app.example.org is already routed to the service "OLD". Take it over to move it to this service.',
		);
		expect(updates).toEqual([]);
	});

	test("the REST body lists each conflict with its owner and whether it can be taken over", async () => {
		const svc = fakeService("new", {});
		const error = (await apply(svc, {
			domains: ["app.example.org", "ide.dev.example.com", "go.example.org"],
		}).catch((err: unknown) => err)) as InstanceType<
			typeof DomainConflictError
		>;
		expect(error.body()).toEqual({
			canTakeOver: false,
			conflicts: [
				{
					canTakeOver: true,
					domain: "app.example.org",
					owner: 'the service "OLD"',
					ownerId: "old",
					ownerKind: "service",
				},
				{
					canTakeOver: false,
					domain: "ide.dev.example.com",
					owner: "a workstation",
					ownerId: null,
					ownerKind: "workstation",
				},
				{
					canTakeOver: true,
					domain: "go.example.org",
					owner: "the redirect from go.example.org/x",
					ownerId: "r1",
					ownerKind: "redirect",
				},
			],
			error: error.message,
		});
		const plain = (await apply(svc, { stackId: "gone" }).catch(
			(err: unknown) => err,
		)) as InstanceType<typeof DomainConflictError>;
		expect(plain.body()).toEqual({ error: "That stack wasn't found." });
	});

	test("a path under another service's domain, or its domain under its path, is free", async () => {
		const svc = fakeService("new", {});
		await apply(svc, {
			domains: ["app.example.org/admin", "example.org"],
		});
		expect(updates.map(([id]) => id)).toEqual(["new"]);
	});

	test("the dashboard, a core service's host and a workstation are refused for good, path or not", async () => {
		const svc = fakeService("new", {});
		for (const domain of [
			"homerun.example.com/app",
			"registry.example.com",
			"ide.dev.example.com",
		]) {
			const error = (await apply(svc, {
				domains: [domain],
				takeOverDomains: true,
			}).catch((err: unknown) => err)) as InstanceType<
				typeof DomainConflictError
			>;
			expect(error).toBeInstanceOf(DomainConflictError);
			expect(error.canTakeOver).toBe(false);
			expect(error.message).not.toContain("Take it over");
		}
		expect(updates).toEqual([]);
	});

	test("a slug change whose default hostname is taken is refused too", async () => {
		const svc = fakeService("new", {});
		services.push(
			fakeService("taken", {
				defaultDomainEnabled: false,
				domains: ["shop.example.com"],
			}),
		);
		const error = await apply(svc, { slug: "shop" }).catch(
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(DomainConflictError);
	});

	test("taking over moves the domain, keeps the owner's DNS and redeploys only the taker", async () => {
		const svc = fakeService("new", {});
		const result = await apply(svc, {
			domains: ["app.example.org"],
			takeOverDomains: true,
		});
		expect(result.takenOver).toEqual(['the service "OLD"']);
		expect(result.redeploying).toBe(true);
		expect(redeployed).toEqual(["new"]);
		expect(updates[0]).toEqual([
			"old",
			{
				defaultDomainEnabled: true,
				domainPorts: {},
				domains: ["example.org/api"],
				primaryDomain: null,
				stripPathDomains: [],
			},
		]);
		expect(svc.toJSON().domains).toEqual(["app.example.org"]);
	});

	test("taking a service's only hostname turns its public routing off", async () => {
		const svc = fakeService("new", {
			defaultDomainEnabled: false,
			domains: ["x.io"],
		});
		await apply(svc, {
			domains: ["x.io", "solo.example.com"],
			takeOverDomains: true,
		});
		expect(updates[0]).toEqual([
			"solo",
			{
				defaultDomainEnabled: false,
				dnsResolvable: false,
				domainPorts: {},
				domains: [],
				primaryDomain: null,
				stripPathDomains: [],
			},
		]);
	});

	test("taking over from a redirect disables it and republishes the redirects", async () => {
		const svc = fakeService("new", {});
		const result = await apply(svc, {
			domains: ["go.example.org"],
			takeOverDomains: true,
		});
		expect(disabledRedirects).toEqual(["r1"]);
		expect(redirectSyncs).toBe(1);
		expect(result.takenOver).toEqual(["the redirect from go.example.org/x"]);
	});
});
