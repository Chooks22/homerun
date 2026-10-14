import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type DomainOwners, stubDomainOwners } from "../support/domain-owners";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { parseComposeFile } = await import("../../../src/lib/compose-import");
const { Logger } = await import("../../../src/lib/logger");
const { NotificationDTO } = await import(
	"../../../src/lib/dto/notification-dto"
);
const { ServiceDependencyDTO } = await import(
	"../../../src/lib/dto/service-dependency-dto"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { ServiceVolumeDTO } = await import(
	"../../../src/lib/dto/service-volume-dto"
);
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { StorageVolumeDTO } = await import(
	"../../../src/lib/dto/storage-volume-dto"
);
const { CapacityService } = await import(
	"../../../src/lib/services/capacity.service"
);
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { ComposeImportService, HostAccessError } = await import(
	"../../../src/lib/services/compose-import.service"
);

const COMPOSE = `
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    volumes:
      - assets:/assets
      - /srv/www:/srv/www:ro
    depends_on:
      - api
      - missing
  api:
    image: ghcr.io/acme/api
volumes:
  assets:
`;

type Draft = ReturnType<typeof parseComposeFile>["services"][number];

let owners: DomainOwners;
let created: Record<string, unknown>[] = [];
let attached: Record<string, unknown>[] = [];
let dependencies: [string, string][] = [];
let stackDeploys: unknown[] = [];
let extracted = 0;

function drafts(overrides: Record<string, Partial<Draft>> = {}): Draft[] {
	return parseComposeFile(COMPOSE).services.map((draft) => ({
		...draft,
		...overrides[draft.key],
	}));
}

beforeEach(async () => {
	owners = await stubDomainOwners();
	created = [];
	attached = [];
	dependencies = [];
	stackDeploys = [];
	extracted = 0;
	stub(Logger.prototype, "info", () => undefined);
	stub(Logger.prototype, "warn", () => undefined);
	stub(CapacityService, "assertRoomForNewService", async () => undefined);
	stub(StackDTO, "get", async (id: string) =>
		id === "s1" ? { id: "s1" } : null,
	);
	stub(StackDTO, "slugTaken", async () => false);
	stub(StackDTO, "create", async () => ({ id: "new-stack" }));
	stub(StorageVolumeDTO, "list", async () => [
		{ id: "v-existing", kind: "bind", source: "/srv/www" },
	]);
	stub(StorageVolumeDTO, "create", async (input: { name: string }) => ({
		id: `v-${input.name}`,
	}));
	stub(ServiceDTO, "slugTaken", async () => false);
	stub(ServiceDTO, "create", async (input: Record<string, unknown>) => {
		created.push(input);
		return { id: `svc-${input.slug}`, name: input.name, slug: input.slug };
	});
	stub(ServiceVolumeDTO, "attach", async (input: Record<string, unknown>) => {
		attached.push(input);
		return {};
	});
	stub(DockerService, "extractIntoVolume", async () => {
		extracted += 1;
	});
	stub(NotificationDTO, "notify", () => undefined);
	stub(
		ServiceDependencyDTO,
		"add",
		async (serviceId: string, dependsOnId: string) => {
			if (dependsOnId === "svc-api" && dependencies.length > 0) {
				throw new Error("cycle");
			}
			dependencies.push([serviceId, dependsOnId]);
		},
	);
	stub(
		DeploymentService,
		"enqueueStackDeploy",
		async (primary: unknown, rest: unknown) => {
			stackDeploys.push([primary, rest]);
		},
	);
});

afterEach(() => {
	restoreStubs();
});

describe("ComposeImportService.importPlan", () => {
	test("creates the services in dependency order, with their volumes, files and dependencies", async () => {
		const result = await ComposeImportService.importPlan({
			allowHostAccess: false,
			drafts: drafts({
				web: {
					files: [{ containerPath: "/etc/nginx/nginx.conf", content: "x" }],
				},
			}),
			stackId: null,
			stackName: "My Stack",
			userId: "u1",
		});
		expect(result.stackId).toBe("new-stack");
		expect(created.map((input) => input.slug)).toEqual(["api", "web"]);
		expect(attached.map((input) => input.containerPath)).toEqual([
			"/assets",
			"/srv/www",
			"/etc/nginx/nginx.conf",
		]);
		expect(attached[1]?.volumeId).toBe("v-existing");
		expect(attached[2]?.readOnly).toBe(true);
		expect(extracted).toBe(1);
		expect(dependencies).toEqual([["svc-web", "svc-api"]]);
	});

	test("keeps an existing stack and drops a stack id that's gone", async () => {
		const kept = await ComposeImportService.importPlan({
			allowHostAccess: false,
			drafts: drafts(),
			stackId: "s1",
			stackName: null,
			userId: "u1",
		});
		const gone = await ComposeImportService.importPlan({
			allowHostAccess: false,
			drafts: drafts(),
			stackId: "s2",
			stackName: null,
			userId: "u1",
		});
		const none = await ComposeImportService.importPlan({
			allowHostAccess: false,
			drafts: drafts(),
			stackId: null,
			stackName: null,
			userId: "u1",
		});
		expect([kept.stackId, gone.stackId, none.stackId]).toEqual([
			"s1",
			null,
			null,
		]);
	});

	test("drops a domain a service, a redirect or a workstation already routes", async () => {
		owners.services.push({ domains: ["app.example.org"], id: "other" });
		owners.redirects.push("go.example.org/x");
		owners.workstations.push("ide.example.org");
		await ComposeImportService.importPlan({
			allowHostAccess: false,
			drafts: drafts({
				web: {
					domains: [
						"app.example.org",
						"go.example.org",
						"ide.example.org/api",
						"app.example.org/api",
						"free.example.org",
						"not a domain",
					],
					stripPathDomains: ["app.example.org/api", "ide.example.org/api"],
				},
			}),
			stackId: null,
			stackName: null,
			userId: "u1",
		});
		const web = created.find((input) => input.slug === "web");
		expect(web?.domains).toEqual(["app.example.org/api", "free.example.org"]);
		expect(web?.stripPathDomains).toEqual(["app.example.org/api"]);
	});

	test("refuses host access without the permission", async () => {
		await expect(
			ComposeImportService.importPlan({
				allowHostAccess: false,
				drafts: drafts({ web: { privileged: true } }),
				stackId: null,
				stackName: null,
				userId: "u1",
			}),
		).rejects.toBeInstanceOf(HostAccessError);
		expect(created).toEqual([]);
	});
});

describe("ComposeImportService.deployImported", () => {
	test("deploys the last service with the others as its dependencies, and nothing for none", async () => {
		const services = [{ id: "a" }, { id: "b" }] as unknown as Parameters<
			typeof ComposeImportService.deployImported
		>[0];
		await ComposeImportService.deployImported([], "u1");
		await ComposeImportService.deployImported(services, "u1");
		expect(stackDeploys).toEqual([[{ id: "b" }, [{ id: "a" }]]]);
	});
});
