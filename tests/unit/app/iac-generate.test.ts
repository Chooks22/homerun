import { describe, expect, test } from "bun:test";
import { SECRET_MASK } from "../../../src/lib/formatting";
import {
	type GeneratedFile,
	generateStructure,
	type Inventory,
	inventoryCounts,
	localNames,
	parseScope,
	scopeToService,
	scopeToStack,
	terraformName,
} from "../../../src/lib/iac/generate";

const inventory: Inventory = {
	homerun_bucket: [
		{ expirationDays: null, id: "s1/state", name: "state", storeId: "s1" },
	],
	homerun_build_cache_registry: [
		{
			id: "r1",
			name: "GHCR",
			passwordSet: true,
			registryUrl: "ghcr.io",
			username: "me",
		},
	],
	homerun_service: [
		{
			containerPort: 80,
			envVars: { API_KEY: "secret", MODE: "prod" },
			id: "svc-1",
			image: "nginx",
			name: "Web",
			privileged: false,
			publishedPorts: [{ containerPort: 53, hostPort: 5353, protocol: "udp" }],
			replicas: 1,
			secretEnvKeys: ["API_KEY"],
			slug: "web",
			stackId: "stack-1",
			tag: "1.27",
		},
		{
			containerPort: 5432,
			envVars: {},
			id: "svc-2",
			image: "postgres",
			name: "DB",
			slug: "web",
			stackId: "stack-2",
		},
	],
	homerun_service_dependency: [
		{ dependsOnId: "svc-2", id: "dep-1", serviceId: "svc-1" },
	],
	homerun_stack: [
		{ id: "stack-1", name: "Apps", parentId: null, slug: "apps" },
		{ id: "stack-2", name: "Data", parentId: "stack-1", slug: "data" },
		{ id: "stack-3", name: "Other", parentId: null, slug: "other" },
	],
	homerun_status_page: [
		{
			id: "page-1",
			name: "Status",
			scope: "stack",
			slug: "status",
			stackId: "stack-3",
		},
	],
	homerun_volume: [
		{ id: "vol-1", kind: "volume", name: "web-data", source: "web-data" },
		{ id: "vol-2", kind: "bind", name: "elsewhere", source: "/srv" },
	],
	homerun_volume_mount: [
		{
			containerPath: "/data",
			id: "m-1",
			readOnly: false,
			serviceId: "svc-1",
			volumeId: "vol-1",
		},
	],
};

describe("terraformName", () => {
	test("turns free text into a Terraform name", () => {
		expect(terraformName("My App!")).toBe("my_app");
		expect(terraformName("9lives")).toBe("r_9lives");
		expect(terraformName("provider")).toBe("r_provider");
		expect(terraformName("--")).toBe("unnamed");
	});
});

describe("localNames", () => {
	test("dedupes names and names edges after both ends", () => {
		const names = localNames(inventory);
		expect(names.get("homerun_service")?.get("svc-1")).toBe("web");
		expect(names.get("homerun_service")?.get("svc-2")).toBe("web_2");
		expect(names.get("homerun_service_dependency")?.get("dep-1")).toBe(
			"web_on_web_2",
		);
		expect(names.get("homerun_volume_mount")?.get("m-1")).toBe("web_web_data");
		expect(names.get("homerun_bucket")?.get("s1/state")).toBe("state");
	});
});

describe("scopeToStack", () => {
	test("keeps a stack, its substacks and what their services use", () => {
		const scoped = scopeToStack(inventory, "stack-1");
		expect(scoped.homerun_stack?.map((stack) => stack.id)).toEqual([
			"stack-1",
			"stack-2",
		]);
		expect(scoped.homerun_service?.length).toBe(2);
		expect(scoped.homerun_volume?.map((volume) => volume.id)).toEqual([
			"vol-1",
		]);
		expect(scoped.homerun_status_page).toEqual([]);
		expect(scoped.homerun_bucket).toBeUndefined();
		expect(inventoryCounts(scoped).map((entry) => entry.type)).not.toContain(
			"homerun_bucket",
		);
	});
});

describe("scopeToService", () => {
	test("keeps the service, what hangs off it and the volumes it mounts", () => {
		const scoped = scopeToService(inventory, "svc-1");
		expect(scoped.homerun_service?.map((svc) => svc.id)).toEqual(["svc-1"]);
		expect(scoped.homerun_service_dependency?.length).toBe(1);
		expect(scoped.homerun_volume?.map((volume) => volume.id)).toEqual([
			"vol-1",
		]);
		expect(scoped.homerun_stack).toBeUndefined();
	});
});

describe("parseScope", () => {
	test("reads stack and service scopes, nothing else", () => {
		expect(parseScope("stack:stack-1")).toEqual({
			id: "stack-1",
			kind: "stack",
		});
		expect(parseScope("service:svc-1")).toEqual({
			id: "svc-1",
			kind: "service",
		});
		expect(parseScope("all")).toBeNull();
		expect(parseScope("volume:x")).toBeNull();
		expect(parseScope(null)).toBeNull();
	});
});

describe("generateStructure", () => {
	const files = generateStructure(inventory, {
		backendAddress: "https://homerun.example.com/api/v1/iac/projects/p1",
		endpoint: "https://homerun.example.com",
		generatedAt: new Date("2026-10-05T12:00:00Z"),
		name: "Apps",
	});
	const file = (path: string) =>
		(files.find((entry) => entry.path === path) as GeneratedFile).content;
	const all = files.map((entry) => entry.content).join("\n");

	test("lays the project out in files, a file per service", () => {
		expect(files.map((entry) => entry.path)).toEqual([
			"README.md",
			"versions.tf",
			"providers.tf",
			"buckets.tf",
			"build_cache_registries.tf",
			"service_web.tf",
			"service_web_2.tf",
			"stacks.tf",
			"volumes.tf",
			"variables.tf",
			"terraform.tfvars",
			"terraform.tfvars.example",
			".gitignore",
		]);
		expect(file("README.md")).toStartWith("# Apps");
		expect(file("README.md")).toContain("1. Export a Homerun API key");
		expect(file("README.md")).not.toContain("Install the Homerun provider");
		expect(file(".gitignore")).toContain("terraform.tfvars");
	});

	test("writes the provider, the backend and an import block next to each object", () => {
		expect(file("versions.tf")).toContain('source = "orochibraru/homerun"');
		expect(file("versions.tf")).toContain(
			'address        = "https://homerun.example.com/api/v1/iac/projects/p1/state"',
		);
		expect(file("providers.tf")).toContain(
			'endpoint = "https://homerun.example.com"',
		);
		expect(file("service_web.tf")).toContain(
			'import {\n  to = homerun_service.web\n  id = "svc-1"\n}',
		);
		expect(file("buckets.tf")).toContain(
			'import {\n  to = homerun_bucket.state\n  id = "s1/state"\n}',
		);
	});

	test("puts a service's dependencies and mounts in its own file", () => {
		expect(file("service_web.tf")).toContain(
			"depends_on_id = homerun_service.web_2.id",
		);
		expect(file("service_web.tf")).toContain('resource "homerun_volume_mount"');
		expect(file("stacks.tf")).toContain('resource "homerun_status_page"');
	});

	test("references generated objects and leaves defaults out", () => {
		expect(all).toContain("stack_id = homerun_stack.apps.id");
		expect(all).toContain("stack_id       = homerun_stack.data.id");
		expect(all).toContain("parent_id = homerun_stack.apps.id");
		expect(all).not.toContain("replicas");
		expect(all).not.toContain("privileged");
		expect(all).toContain("container_port = 53");
	});

	test("turns secrets into sensitive variables with an example tfvars", () => {
		expect(file("variables.tf")).toContain('variable "web_api_key" {');
		expect(file("variables.tf")).toContain("sensitive   = true");
		expect(file("service_web.tf")).toContain("API_KEY = var.web_api_key");
		expect(file("service_web.tf")).toContain('MODE    = "prod"');
		expect(all).toContain("password     = var.ghcr_password");
		expect(file("terraform.tfvars.example")).toContain('web_api_key = ""');
		expect(file("README.md")).toContain("terraform.tfvars.example");
	});

	test("puts secret env var values in terraform.tfvars, never in the .tf files", () => {
		expect(file("terraform.tfvars")).toContain('web_api_key = "secret"');
		expect(
			files
				.filter((entry) => entry.path.endsWith(".tf"))
				.some((entry) => entry.content.includes('"secret"')),
		).toBe(false);
	});

	test("comments out secrets Homerun never returns, so Terraform asks for them", () => {
		expect(file("terraform.tfvars")).toContain(
			'# ghcr_password = "" # Homerun never returns it: fill it in',
		);
	});

	test("masks the values in the preview a page shows", () => {
		const tfvars = files.find((entry) => entry.path === "terraform.tfvars");
		expect(tfvars?.preview).toContain(`web_api_key = "${SECRET_MASK}"`);
		expect(tfvars?.preview).not.toContain('"secret"');
		expect(files.filter((entry) => entry.preview).length).toBe(1);
	});

	test("escapes quotes and template sequences in a secret's value", () => {
		const escaped = generateStructure(
			{
				homerun_service: [
					{
						envVars: { TOKEN: 'a"b${c}' },
						id: "s9",
						image: "nginx",
						name: "Api",
						secretEnvKeys: ["TOKEN"],
						slug: "api",
					},
				],
			},
			{
				backendAddress: null,
				endpoint: "http://x",
				generatedAt: new Date(0),
				name: "Api",
			},
		).find((entry) => entry.path === "terraform.tfvars")?.content;
		expect(escaped).toBe('api_token = "a\\"b$${c}"\n');
	});

	test("a cron job's secret env vars become variables like a service's", () => {
		const generated = generateStructure(
			{
				homerun_cron_job: [
					{
						envVars: { TOKEN: "t0k3n", TZ: "UTC" },
						id: "c1",
						image: "alpine",
						kind: "image",
						name: "Nightly",
						schedule: "0 3 * * *",
						secretEnvKeys: ["TOKEN"],
					},
				],
			},
			{
				backendAddress: null,
				endpoint: "http://x",
				generatedAt: new Date(0),
				name: "Nightly",
			},
		);
		const all = generated.map((entry) => entry.content).join("\n");
		expect(all).toContain("TOKEN = var.nightly_token");
		expect(all).toContain('secret_env_keys = ["TOKEN"]');
		expect(
			generated.find((entry) => entry.path === "terraform.tfvars")?.content,
		).toBe('nightly_token = "t0k3n"\n');
	});

	test("is stable and works without a backend or secrets", () => {
		const options = {
			backendAddress: null,
			endpoint: "http://localhost:3000",
			generatedAt: new Date(0),
			name: "Web",
		};
		const scoped = scopeToService(inventory, "svc-2");
		const first = generateStructure(scoped, options);
		expect(generateStructure(scoped, options)).toEqual(first);
		const paths = first.map((entry) => entry.path);
		expect(paths).not.toContain("variables.tf");
		expect(paths).not.toContain("terraform.tfvars.example");
		expect(
			first.find((entry) => entry.path === "versions.tf")?.content,
		).not.toContain('backend "http"');
		expect(
			first.find((entry) => entry.path === "README.md")?.content,
		).not.toContain("TF_HTTP_PASSWORD");
	});
});
