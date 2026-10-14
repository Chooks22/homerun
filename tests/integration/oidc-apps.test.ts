import { afterAll, describe, expect, test } from "bun:test";
import * as devalue from "devalue";
import { nativeFetch } from "./support/config";
import { integrationContext } from "./support/context";

const ADMIN_EMAIL = "admin@integration.test";
const ADMIN_PASSWORD = "integration-test-password-1234";
const SECOND_ADMIN_EMAIL = "second-admin@integration.test";
const SECOND_ADMIN_PASSWORD = "second-admin-integration-password-1234";
const CALLBACK = "https://app.oidc-it.test/callback";

interface OidcApp {
	clientId: string;
	confidential: boolean;
	id: string;
	name: string;
	requirePkce: boolean;
	tokenAuthMethod: string | null;
}

const createdApps: string[] = [];
let secondAdminId: string | null = null;

function api(method: string, path: string, body?: unknown): Promise<Response> {
	const { apiKey, origin } = integrationContext();
	return nativeFetch(`${origin}/api/v1${path}`, {
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: { "content-type": "application/json", "x-api-key": apiKey },
		method,
	});
}

async function created<T>(res: Response): Promise<T> {
	expect(res.status, await res.clone().text()).toBe(201);
	return (await res.json()) as T;
}

async function signIn(email: string, password: string): Promise<string> {
	const { origin } = integrationContext();
	const res = await nativeFetch(`${origin}/api/v1/auth/sign-in/email`, {
		body: JSON.stringify({ email, password }),
		headers: { "content-type": "application/json", origin },
		method: "POST",
	});
	expect(res.status, await res.clone().text()).toBe(200);
	return res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function formAction(
	cookie: string,
	path: string,
	fields: Record<string, string | string[]>,
): Promise<{ data: Record<string, unknown>; type: string }> {
	const { origin } = integrationContext();
	const body = new URLSearchParams();
	for (const [name, value] of Object.entries(fields)) {
		for (const entry of [value].flat()) {
			body.append(name, entry);
		}
	}
	const res = await nativeFetch(`${origin}${path}`, {
		body,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			origin,
			"x-sveltekit-action": "true",
		},
		method: "POST",
	});
	const envelope = (await res.json()) as { data?: string; type: string };
	return {
		data: devalue.parse(envelope.data ?? "{}") as Record<string, unknown>,
		type: envelope.type,
	};
}

async function registerApp(body: Record<string, unknown>): Promise<OidcApp> {
	const app = await created<OidcApp>(await api("POST", "/oidc-apps", body));
	createdApps.push(app.id);
	return app;
}

afterAll(async () => {
	for (const id of createdApps) {
		await api("DELETE", `/oidc-apps/${id}`);
	}
	if (secondAdminId) {
		await api("DELETE", `/users/${secondAdminId}`);
	}
});

describe("OIDC apps over the REST API", () => {
	test("an API key registers an app, its environment and a secret, and the app signs people in", async () => {
		const { origin } = integrationContext();
		const app = await registerApp({ name: "IT API app", skipConsent: true });
		expect(app).toMatchObject({
			confidential: true,
			name: "IT API app",
			requirePkce: true,
			tokenAuthMethod: "client_secret_basic",
		});

		const environment = await created<{ id: string }>(
			await api("POST", `/oidc-apps/${app.id}/environments`, {
				name: "production",
				redirectUris: [CALLBACK],
			}),
		);
		const { secret } = await created<{ secret: string }>(
			await api("POST", `/oidc-apps/${app.id}/secrets`, {
				environmentId: environment.id,
				label: "it",
			}),
		);
		expect(secret).toBeTruthy();
		const listed = (await (
			await api("GET", `/oidc-apps/${app.id}/secrets`)
		).json()) as { hint: string; label: string }[];
		expect(listed).toEqual([
			expect.objectContaining({ hint: secret.slice(-4), label: "it" }),
		]);

		const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const verifier = crypto.randomUUID() + crypto.randomUUID();
		const challenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		).toString("base64url");
		const authorizeUrl = new URL(`${origin}/api/v1/auth/oauth2/authorize`);
		for (const [name, value] of Object.entries({
			client_id: app.clientId,
			code_challenge: challenge,
			code_challenge_method: "S256",
			redirect_uri: CALLBACK,
			response_type: "code",
			scope: "openid email",
			state: "integration",
		})) {
			authorizeUrl.searchParams.set(name, value);
		}
		const authorized = await nativeFetch(authorizeUrl, {
			headers: { cookie },
			redirect: "manual",
		});
		const callback = new URL(authorized.headers.get("location") ?? "", origin);
		expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
		const code = callback.searchParams.get("code") ?? "";
		expect(code).not.toBe("");

		const tokened = await nativeFetch(`${origin}/api/v1/auth/oauth2/token`, {
			body: new URLSearchParams({
				code,
				code_verifier: verifier,
				grant_type: "authorization_code",
				redirect_uri: CALLBACK,
			}),
			headers: {
				authorization: `Basic ${Buffer.from(`${app.clientId}:${secret}`).toString("base64")}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		});
		expect(tokened.status, await tokened.clone().text()).toBe(200);
		expect(
			((await tokened.json()) as { id_token?: string }).id_token,
		).toBeTruthy();
	});

	test("refuses what a public app can't have and environments the dashboard would refuse", async () => {
		const refusedPublic = await api("POST", "/oidc-apps", {
			confidential: false,
			name: "IT refused",
			tokenAuthMethod: "client_secret_post",
		});
		expect(refusedPublic.status).toBe(400);

		const app = await registerApp({ confidential: false, name: "IT SPA" });
		expect(app).toMatchObject({
			confidential: false,
			requirePkce: true,
			tokenAuthMethod: null,
		});
		expect(
			(await api("PATCH", `/oidc-apps/${app.id}`, { requirePkce: false }))
				.status,
		).toBe(400);
		expect(
			(
				await api("PATCH", `/oidc-apps/${app.id}`, {
					tokenAuthMethod: "client_secret_basic",
				})
			).status,
		).toBe(400);

		const insecure = await api("POST", `/oidc-apps/${app.id}/environments`, {
			name: "production",
			redirectUris: ["http://spa.oidc-it.test/callback"],
		});
		expect(insecure.status).toBe(400);
		expect(await insecure.text()).toContain("https");

		const environment = await created<{ id: string }>(
			await api("POST", `/oidc-apps/${app.id}/environments`, {
				allowedOrigins: ["https://spa.oidc-it.test/"],
				name: "production",
				redirectUris: ["https://spa.oidc-it.test/callback"],
			}),
		);
		const duplicate = await api("POST", `/oidc-apps/${app.id}/environments`, {
			name: "production",
			redirectUris: ["https://spa.oidc-it.test/other"],
		});
		expect(duplicate.status).toBe(400);
		expect(
			(
				await api("POST", `/oidc-apps/${app.id}/secrets`, {
					environmentId: environment.id,
				})
			).status,
		).toBe(400);

		const patched = await api(
			"PATCH",
			`/oidc-apps/${app.id}/environments/${environment.id}`,
			{ allowLocalhost: true, redirectUris: ["http://localhost:5173/cb"] },
		);
		expect(patched.status, await patched.clone().text()).toBe(200);
		expect(await patched.json()).toMatchObject({
			allowedOrigins: ["https://spa.oidc-it.test"],
			allowLocalhost: true,
			name: "production",
			redirectUris: ["http://localhost:5173/cb"],
		});

		expect(
			(
				await api(
					"DELETE",
					`/oidc-apps/${app.id}/environments/${environment.id}`,
				)
			).status,
		).toBe(204);
		expect((await api("DELETE", `/oidc-apps/${app.id}`)).status).toBe(204);
		expect((await api("GET", `/oidc-apps/${app.id}`)).status).toBe(404);
	});
});

describe("OIDC apps on the dashboard", () => {
	test("another admin can edit an app the first one registered", async () => {
		const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const registered = await formAction(adminCookie, "/idp/new?/create", {
			clientType: "confidential",
			environmentName: "production",
			name: "IT shared app",
			redirectUris: CALLBACK,
			requirePkce: "on",
		});
		expect(registered.type).toBe("success");
		const { clientId } = registered.data.created as { clientId: string };
		const apps = (await (await api("GET", "/oidc-apps")).json()) as OidcApp[];
		const app = apps.find((entry) => entry.clientId === clientId);
		if (!app) {
			throw new Error("the registered app isn't listed");
		}
		createdApps.push(app.id);

		const { origin } = integrationContext();
		const createdUser = await nativeFetch(
			`${origin}/api/v1/auth/admin/create-user`,
			{
				body: JSON.stringify({
					email: SECOND_ADMIN_EMAIL,
					name: "Second admin",
					password: SECOND_ADMIN_PASSWORD,
					role: "admin",
				}),
				headers: {
					"content-type": "application/json",
					cookie: adminCookie,
					origin,
				},
				method: "POST",
			},
		);
		expect(createdUser.status, await createdUser.clone().text()).toBe(200);
		secondAdminId = ((await createdUser.json()) as { user: { id: string } })
			.user.id;
		const secondCookie = await signIn(
			SECOND_ADMIN_EMAIL,
			SECOND_ADMIN_PASSWORD,
		);

		const saved = await formAction(
			secondCookie,
			`/idp/${app.id}/settings?/update`,
			{
				name: "IT shared app, renamed",
				requirePkce: "on",
				skipConsent: "on",
				tokenAuthMethod: "client_secret_post",
			},
		);
		expect(saved.type, JSON.stringify(saved.data)).toBe("success");
		const added = await formAction(
			secondCookie,
			`/idp/${app.id}/environments?/createEnvironment`,
			{
				environmentName: "staging",
				redirectUris: "https://staging.oidc-it.test/callback",
			},
		);
		expect(added.type, JSON.stringify(added.data)).toBe("success");

		expect(
			await (await api("GET", `/oidc-apps/${app.id}`)).json(),
		).toMatchObject({
			name: "IT shared app, renamed",
			skipConsent: true,
			tokenAuthMethod: "client_secret_post",
		});
		const environments = (await (
			await api("GET", `/oidc-apps/${app.id}/environments`)
		).json()) as { name: string }[];
		expect(environments.map((environment) => environment.name)).toEqual([
			"production",
			"staging",
		]);
	});
});
