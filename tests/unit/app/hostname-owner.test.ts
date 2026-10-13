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
const { hostnameOwner } = await import(
	"../../../src/lib/server/hostname-owner"
);

type Settings = Awaited<ReturnType<typeof InstanceSettingsDTO.get>>;
type Service = Awaited<ReturnType<typeof ServiceDTO.list>>[number];
type Stack = Awaited<ReturnType<typeof StackDTO.list>>[number];
type Redirect = Awaited<ReturnType<typeof RedirectDTO.list>>[number];
type Ws = Awaited<ReturnType<typeof WorkstationDTO.listAll>>[number];

const restorers: { mockRestore: () => void }[] = [];
const originalOrigin = config.auth.origin;
const originalBase = config.baseDomain;

function svc(row: Record<string, unknown>): Service {
	return {
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
				domains: ["shop.example.org"],
				name: "Shop",
				slug: "shop",
			}),
		]),
		spyOn(StackDTO, "list").mockResolvedValue([
			{ id: "s1", toJSON: () => ({ slug: "site" }) } as unknown as Stack,
		]),
		spyOn(RedirectDTO, "list").mockResolvedValue([
			{
				toJSON: () => ({ source: "old.example.com/path" }),
			} as unknown as Redirect,
		]),
		spyOn(StatusPageDTO, "domainOwner").mockImplementation(async (domains) =>
			domains.includes("status.example.com")
				? { domain: "status.example.com", name: "Status" }
				: null,
		),
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
