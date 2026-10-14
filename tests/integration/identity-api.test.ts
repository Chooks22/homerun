import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectOk } from "./support/assert";
import { ServiceCleanup } from "./support/cleanup";
import type { ApiClient } from "./support/client";
import { apiClient, integrationContext } from "./support/context";

const PROVIDER = "it-identity";

const NativeResponse = Response;

let client: ApiClient;
let cleanup: ServiceCleanup;
let discovery: ReturnType<typeof Bun.serve>;
let discoveryUrl: string;
let userId: string | null = null;

function providerBody(fields: {
	clientId: string;
	clientSecret?: string;
	discoveryUrl: string;
	name: string;
}) {
	return {
		enabled: true,
		pkce: true,
		scopes: ["openid", "profile", "email"],
		signOutOfProvider: false,
		tokenAuthMethod: "auto" as const,
		...fields,
	};
}

beforeAll(() => {
	client = apiClient();
	cleanup = new ServiceCleanup(client);
	discovery = Bun.serve({
		fetch(request) {
			const issuer = new URL(request.url).origin;
			return NativeResponse.json({
				authorization_endpoint: `${issuer}/authorize`,
				issuer,
				jwks_uri: `${issuer}/jwks`,
				token_endpoint: `${issuer}/token`,
				token_endpoint_auth_methods_supported: ["client_secret_basic"],
				userinfo_endpoint: `${issuer}/userinfo`,
			});
		},
		hostname: "127.0.0.1",
		port: 0,
	});
	discoveryUrl = `http://127.0.0.1:${discovery.port}/.well-known/openid-configuration`;
});

afterAll(async () => {
	await cleanup.cleanupAll();
	await client.DELETE("/oauth-providers/{providerName}", {
		params: { path: { providerName: PROVIDER } },
	});
	if (userId) {
		await client.DELETE("/users/{userId}", {
			params: { path: { userId } },
		});
	}
	discovery.stop(true);
});

describe("users API", () => {
	test("creates, reads, updates and deletes a user", async () => {
		const email = `it-${Date.now().toString(36)}@identity.test`;
		const created = await client.POST("/users", {
			body: { email, name: "IT person", role: "developer" },
		});
		expect(created.response.status).toBe(201);
		const user = expectOk(created.data, created.response);
		userId = user.id;
		expect(user).toMatchObject({ email, permissions: {}, role: "developer" });

		const read = await client.GET("/users/{userId}", {
			params: { path: { userId: user.id } },
		});
		expect(expectOk(read.data, read.response).email).toBe(email);

		const custom = await client.PATCH("/users/{userId}", {
			body: {
				name: "IT renamed",
				permissions: { services: "read" },
				role: "custom",
			},
			params: { path: { userId: user.id } },
		});
		expect(expectOk(custom.data, custom.response)).toMatchObject({
			name: "IT renamed",
			permissions: { services: "read" },
			role: "custom",
		});

		const listed = await client.GET("/users", {
			params: { query: { q: email } },
		});
		expect(expectOk(listed.data, listed.response).map((row) => row.id)).toEqual(
			[user.id],
		);

		const deleted = await client.DELETE("/users/{userId}", {
			params: { path: { userId: user.id } },
		});
		expect(deleted.response.status).toBe(204);
		userId = null;
		const gone = await client.GET("/users/{userId}", {
			params: { path: { userId: user.id } },
		});
		expect(gone.response.status).toBe(404);
	});

	test("refuses what the Users page refuses", async () => {
		const { userId: adminId } = integrationContext();
		const admin = await client.GET("/users/{userId}", {
			params: { path: { userId: adminId } },
		});
		const adminEmail = expectOk(admin.data, admin.response).email;

		const taken = await client.POST("/users", {
			body: { email: adminEmail, name: "Copy", role: "viewer" },
		});
		expect(taken.response.status).toBe(400);

		const presetWithPermissions = await client.POST("/users", {
			body: {
				email: `it-preset-${Date.now().toString(36)}@identity.test`,
				name: "Preset",
				permissions: { services: "write" },
				role: "viewer",
			},
		});
		expect(presetWithPermissions.response.status).toBe(400);

		const self = await client.DELETE("/users/{userId}", {
			params: { path: { userId: adminId } },
		});
		expect(self.response.status).toBe(400);
	});
});

describe("OAuth providers API", () => {
	test("creates, reads, updates and deletes a provider, never returning its secret", async () => {
		const created = await client.POST("/oauth-providers", {
			body: providerBody({
				clientId: "homerun",
				clientSecret: "it-secret",
				discoveryUrl,
				name: PROVIDER,
			}),
		});
		expect(created.response.status).toBe(201);
		const provider = expectOk(created.data, created.response);
		expect(provider).toMatchObject({
			clientSecretSet: true,
			id: PROVIDER,
			label: PROVIDER,
			tokenAuthMethod: "auto",
		});
		expect(JSON.stringify(provider)).not.toContain("it-secret");

		const updated = await client.PATCH("/oauth-providers/{providerName}", {
			body: { label: "IT provider", pkce: false },
			params: { path: { providerName: PROVIDER } },
		});
		expect(expectOk(updated.data, updated.response)).toMatchObject({
			clientSecretSet: true,
			label: "IT provider",
			pkce: false,
		});

		const duplicate = await client.POST("/oauth-providers", {
			body: providerBody({ clientId: "other", discoveryUrl, name: PROVIDER }),
		});
		expect(duplicate.response.status).toBe(400);

		const unreachable = await client.POST("/oauth-providers", {
			body: providerBody({
				clientId: "other",
				discoveryUrl: "http://127.0.0.1:9/.well-known/openid-configuration",
				name: "it-unreachable",
			}),
		});
		expect(unreachable.response.status).toBe(400);
	});

	test("login walls accept an enabled provider and refuse a method that isn't", async () => {
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
				envVars: {},
				gitBuildMethod: "dockerfile",
				image: "nginx",
				labels: {},
				name: `IT login wall ${suffix}`,
				privileged: false,
				pullPolicy: "missing",
				restartPolicy: "no",
				slug: `it-wall-${suffix}`,
				tag: "alpine",
			},
		});
		const service = expectOk(created.data, created.response);
		cleanup.track(service.id);
		const patch = (body: Record<string, unknown>) =>
			client.PATCH("/services/{serviceId}", {
				body,
				params: { path: { serviceId: service.id } },
			});

		expect(
			(await patch({ authProviders: ["magic-link"], authRequired: true }))
				.response.status,
		).toBe(400);
		expect(
			(await patch({ authProviders: [], authRequired: true })).response.status,
		).toBe(400);
		expect(
			(await patch({ authAllowedEmails: ["not an email"] })).response.status,
		).toBe(400);
		expect(
			(await patch({ authProviders: ["oauth:nope"] })).response.status,
		).toBe(400);

		const walled = await patch({
			authAllowedEmails: ["*@identity.test"],
			authProviders: [`oauth:${PROVIDER}`, "password"],
			authRequired: true,
		});
		expect(expectOk(walled.data, walled.response)).toMatchObject({
			authProviders: [`oauth:${PROVIDER}`, "password"],
			authRequired: true,
		});

		const deleted = await client.DELETE("/oauth-providers/{providerName}", {
			params: { path: { providerName: PROVIDER } },
		});
		expect(deleted.response.status).toBe(204);
		const gone = await client.GET("/oauth-providers/{providerName}", {
			params: { path: { providerName: PROVIDER } },
		});
		expect(gone.response.status).toBe(404);
	});
});
