import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectOk } from "./support/assert";
import { ServiceCleanup } from "./support/cleanup";
import type { ApiClient } from "./support/client";
import { nativeFetch } from "./support/config";
import { apiClient, integrationContext } from "./support/context";

let client: ApiClient;
let cleanup: ServiceCleanup;

function send(
	method: string,
	path: string,
	body: string,
	contentType = "application/json",
): Promise<Response> {
	const { apiKey, origin } = integrationContext();
	return nativeFetch(`${origin}/api/v1${path}`, {
		body,
		headers: { "content-type": contentType, "x-api-key": apiKey },
		method,
	});
}

async function imageService(name: string) {
	const suffix = Date.now().toString(36);
	const created = await client.POST("/services", {
		body: {
			authRequired: false,
			autoDeployOnPush: false,
			buildSource: "image",
			capAdd: [],
			containerPort: 80,
			devices: [],
			dnsResolvable: false,
			envFiles: [],
			envVars: { KEPT: "from the dashboard" },
			gitBuildMethod: "dockerfile",
			image: "nginx",
			labels: {},
			name: `${name} ${suffix}`,
			privileged: false,
			pullPolicy: "missing",
			restartPolicy: "no",
			slug: `it-${name}-${suffix}`,
			tag: "alpine",
		},
	});
	const service = expectOk(created.data, created.response);
	cleanup.track(service.id);
	return service;
}

beforeAll(() => {
	client = apiClient();
	cleanup = new ServiceCleanup(client);
});

afterAll(async () => {
	await cleanup.cleanupAll();
});

describe("Homerun Manifests", () => {
	test("the JSON schema is public", async () => {
		const { origin } = integrationContext();
		const res = await nativeFetch(`${origin}/api/v1/manifest.schema.json`);
		expect(res.status).toBe(200);
		const schema = (await res.json()) as {
			additionalProperties: boolean;
			title: string;
		};
		expect(schema.title).toBe("Homerun Manifest");
		expect(schema.additionalProperties).toBe(false);
	});

	test("validate names every problem, JSON or YAML", async () => {
		const good = await send(
			"POST",
			"/manifests/validate",
			"containerPort: 3000\n",
			"application/yaml",
		);
		expect(await good.json()).toEqual({ errors: [], valid: true });
		const bad = await send(
			"POST",
			"/manifests/validate",
			'{"port": 3000, "privileged": true}',
		);
		const verdict = (await bad.json()) as { errors: string[]; valid: boolean };
		expect(verdict.valid).toBe(false);
		expect(verdict.errors.join("\n")).toContain('"port"');
		expect(verdict.errors.join("\n")).toContain('"privileged"');
	});

	test("applying merges the environment and goes through the service's checks", async () => {
		const service = await imageService("manifest-apply");
		const applied = await send(
			"PUT",
			`/services/${service.id}/manifest`,
			JSON.stringify({
				containerPort: 8080,
				envVars: { FROM_MANIFEST: "yes" },
				healthcheckDisabled: true,
			}),
		);
		expect(applied.status).toBe(200);
		expect(await applied.json()).toEqual({
			applied: ["containerPort", "envVars", "healthcheckDisabled"],
			ignored: [],
		});
		const fresh = await client.GET("/services/{serviceId}", {
			params: { path: { serviceId: service.id } },
		});
		expect(expectOk(fresh.data, fresh.response)).toMatchObject({
			containerPort: 8080,
			envVars: { FROM_MANIFEST: "yes", KEPT: "from the dashboard" },
		});

		const refused = await send(
			"PUT",
			`/services/${service.id}/manifest`,
			"authRequired: true\nauthProviders: [oauth:not-configured]\n",
			"application/yaml",
		);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toContain(
			"oauth:not-configured",
		);
	});

	test("a git deploy applies the manifest in the repository", async () => {
		const ctx = integrationContext();
		const suffix = Date.now().toString(36);
		const created = await client.POST("/services", {
			body: {
				authRequired: false,
				autoDeployOnPush: false,
				buildSource: "git",
				capAdd: [],
				containerPort: 80,
				devices: [],
				dnsResolvable: false,
				envFiles: [],
				envVars: { KEPT: "from the dashboard" },
				gitBuildMethod: "dockerfile",
				gitRef: "main",
				gitUrl: ctx.gitBuildFixtureUrl.replace(/\/repo$/, "/manifest-repo"),
				labels: {},
				name: `IT manifest repo ${suffix}`,
				privileged: false,
				pullPolicy: "always",
				restartPolicy: "no",
				slug: `it-manifest-repo-${suffix}`,
			},
		});
		const service = expectOk(created.data, created.response);
		cleanup.track(service.id);

		const deployed = await client.POST("/services/{serviceId}/deploy", {
			body: {},
			params: { path: { serviceId: service.id } },
		});
		expectOk(deployed.data, deployed.response);

		const fresh = await client.GET("/services/{serviceId}", {
			params: { path: { serviceId: service.id } },
		});
		expect(expectOk(fresh.data, fresh.response)).toMatchObject({
			containerPort: 8080,
			envVars: { FROM_MANIFEST: "yes", KEPT: "from the dashboard" },
		});
		const deployments = await client.GET("/services/{serviceId}/deployments", {
			params: { path: { serviceId: service.id } },
		});
		const [latest] = expectOk(deployments.data, deployments.response);
		expect(latest?.log ?? "").toContain("Applied .homerun.yaml from ");
		expect(latest?.log ?? "").toContain("containerPort, envVars");
	}, 240_000);
});
