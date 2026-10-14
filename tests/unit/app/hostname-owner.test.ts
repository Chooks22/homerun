import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { RedirectDTO } = await import("../../../src/lib/dto/redirect-dto");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { StatusPageDTO } = await import("../../../src/lib/dto/status-page-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { coreHosts, hostnameOwner, serviceDomainConflicts } = await import(
	"../../../src/lib/server/hostname-owner"
);

type Settings = Awaited<ReturnType<typeof InstanceSettingsDTO.get>>;
type Service = Awaited<ReturnType<typeof ServiceDTO.list>>[number];
type Stack = Awaited<ReturnType<typeof StackDTO.list>>[number];
type Redirect = Awaited<ReturnType<typeof RedirectDTO.list>>[number];
type Ws = Awaited<ReturnType<typeof WorkstationDTO.listAll>>[number];
type Page = Awaited<ReturnType<typeof StatusPageDTO.list>>[number];

const restorers: { mockRestore: () => void }[] = [];
const originalOrigin = config.auth.origin;
const originalBase = config.baseDomain;
const originalSubdomain = config.serviceSubdomain;

function svc(row: Record<string, unknown>): Service {
	return {
		dnsResolvable: true,
		id: row.slug,
		name: row.name,
		toJSON: () => ({
			defaultDomainEnabled: true,
			domains: [],
			stackId: null,
			...row,
		}),
	} as unknown as Service;
}

beforeEach(() => {
	config.auth.origin = "https://homerun.example.com";
	config.baseDomain = "example.com";
	restorers.push(
		spyOn(InstanceSettingsDTO, "get").mockResolvedValue({
			toJSON: () => ({
				garagePublicHost: "s3.example.com",
				registryPublicHost: "registry.example.com",
			}),
		} as unknown as Settings),
		spyOn(ServiceDTO, "list").mockResolvedValue([
			svc({ name: "Penombre", slug: "penombre" }),
			svc({ name: "Blog", slug: "blog", stackId: "s1" }),
			svc({
				defaultDomainEnabled: false,
				domains: ["shop.example.org", "api.example.org/v1"],
				name: "Shop",
				slug: "shop",
			}),
		]),
		spyOn(StackDTO, "list").mockResolvedValue([
			{ id: "s1", toJSON: () => ({ slug: "site" }) } as unknown as Stack,
		]),
		spyOn(RedirectDTO, "list").mockResolvedValue([
			{
				toJSON: () => ({
					enabled: true,
					id: "r1",
					source: "old.example.com/path",
				}),
			} as unknown as Redirect,
			{
				toJSON: () => ({ enabled: false, id: "r2", source: "off.example.com" }),
			} as unknown as Redirect,
		]),
		spyOn(StatusPageDTO, "list").mockResolvedValue([
			{ domains: ["status.example.com"], name: "Status" } as unknown as Page,
		]),
		spyOn(WorkstationDTO, "listAll").mockResolvedValue([
			{
				id: "w1",
				toJSON: () => ({ domain: "alice.dev.example.com", slug: "alice" }),
			} as unknown as Ws,
			{
				id: "w2",
				toJSON: () => ({ domain: null, slug: "legacy" }),
			} as unknown as Ws,
		]),
	);
});

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
	config.auth.origin = originalOrigin;
	config.baseDomain = originalBase;
	config.serviceSubdomain = originalSubdomain;
});

describe("coreHosts", () => {
	test("names the dashboard, the core services' public hosts and every status page domain", async () => {
		expect(Object.fromEntries(await coreHosts())).toEqual({
			"homerun.example.com": "the Homerun dashboard",
			"registry.example.com": "the Docker registry",
			"s3.example.com": "object storage",
			"status.example.com": 'the status page "Status"',
		});
	});
});

describe("serviceDomainConflicts", () => {
	test("Homerun's own hosts and workstations are taken on the host, whatever the path", async () => {
		expect(
			await serviceDomainConflicts([
				"homerun.example.com/app",
				"status.example.com",
				"alice.dev.example.com",
			]),
		).toEqual([
			{
				entry: "homerun.example.com/app",
				owner: { kind: "core", label: "the Homerun dashboard" },
			},
			{
				entry: "status.example.com",
				owner: { kind: "core", label: 'the status page "Status"' },
			},
			{
				entry: "alice.dev.example.com",
				owner: { kind: "workstation", label: "a workstation" },
			},
		]);
	});

	test("an enabled redirect is taken on its host, a disabled one isn't", async () => {
		expect(await serviceDomainConflicts(["old.example.com"])).toEqual([
			{
				entry: "old.example.com",
				owner: {
					id: "r1",
					kind: "redirect",
					label: "the redirect from old.example.com/path",
				},
			},
		]);
		expect(await serviceDomainConflicts(["off.example.com"])).toEqual([]);
	});

	test("another service is only taken on the very same entry", async () => {
		expect(
			await serviceDomainConflicts([
				"api.example.org/v1",
				"api.example.org",
				"shop.example.org/api",
				"PENOMBRE.example.com",
			]),
		).toEqual([
			{
				entry: "api.example.org/v1",
				owner: { id: "shop", kind: "service", label: 'the service "Shop"' },
			},
			{
				entry: "penombre.example.com",
				owner: {
					id: "penombre",
					kind: "service",
					label: 'the service "Penombre"',
				},
			},
		]);
	});

	test("the service being saved doesn't conflict with itself", async () => {
		expect(await serviceDomainConflicts(["shop.example.org"], "shop")).toEqual(
			[],
		);
	});

	test("default hostnames follow the services subdomain", async () => {
		config.serviceSubdomain = "apps";
		expect(await serviceDomainConflicts(["penombre.example.com"])).toEqual([]);
		expect(
			(await serviceDomainConflicts(["penombre.apps.example.com"]))[0]?.owner,
		).toEqual({
			id: "penombre",
			kind: "service",
			label: 'the service "Penombre"',
		});
	});
});

describe("hostnameOwner", () => {
	test("a free hostname has no owner, a service's namesake under dev. included", async () => {
		expect(await hostnameOwner("penombre.dev.example.com")).toBeNull();
	});

	test("the dashboard and the core services' public hosts are taken", async () => {
		expect(await hostnameOwner("HOMERUN.example.com")).toBe(
			"the Homerun dashboard",
		);
		expect(await hostnameOwner("registry.example.com")).toBe(
			"the Docker registry",
		);
		expect(await hostnameOwner("s3.example.com")).toBe("object storage");
	});

	test("a service's default hostname or its own domains are taken", async () => {
		expect(await hostnameOwner("penombre.example.com")).toBe(
			'the service "Penombre"',
		);
		expect(await hostnameOwner("shop.example.org")).toBe('the service "Shop"');
		expect(await hostnameOwner("shop.example.com")).toBeNull();
	});

	test("redirects, status pages and other workstations are taken", async () => {
		expect(await hostnameOwner("old.example.com")).toBe("a redirect");
		expect(await hostnameOwner("status.example.com")).toBe(
			'the status page "Status"',
		);
		expect(await hostnameOwner("alice.dev.example.com")).toBe(
			"another workstation",
		);
		expect(await hostnameOwner("legacy.example.com")).toBe(
			"another workstation",
		);
		expect(await hostnameOwner("alice.dev.example.com", "w1")).toBeNull();
	});
});
