import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectOk } from "./support/assert";
import { ServiceCleanup } from "./support/cleanup";
import type { ApiClient } from "./support/client";
import { nativeFetch } from "./support/config";
import { apiClient, integrationContext } from "./support/context";
import { startMailSink } from "./support/mail-sink";

const ADMIN_EMAIL = "admin@integration.test";
const ADMIN_PASSWORD = "integration-test-password-1234";
const PREVIEW_HOST = "pr-12.preview.integration.test";

let client: ApiClient;
let cleanup: ServiceCleanup;
let account: { id: string; name: string };
let accountKey: string;
let previewId: string;
let adminCookie: string;

function cookiesOf(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

function post(path: string, body: unknown, cookie = ""): Promise<Response> {
	const { origin } = integrationContext();
	return nativeFetch(`${origin}${path}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json", cookie, origin },
		method: "POST",
	});
}

function withKey(path: string, key = accountKey): Promise<Response> {
	const { origin } = integrationContext();
	return nativeFetch(`${origin}${path}`, {
		headers: { "x-api-key": key },
		redirect: "manual",
	});
}

function gateCheck(uri: string, cookie?: string): Promise<Response> {
	const { origin } = integrationContext();
	return nativeFetch(`${origin}/api/v1/auth-check?service=${previewId}`, {
		headers: {
			"x-forwarded-host": PREVIEW_HOST,
			"x-forwarded-proto": "https",
			"x-forwarded-uri": uri,
			...(cookie ? { cookie } : {}),
		},
		redirect: "manual",
	});
}

async function appAuthWithKey(key = accountKey): Promise<Response> {
	const challenge = await gateCheck("/checkout");
	expect(challenge.status).toBe(302);
	const rd = new URL(challenge.headers.get("location") ?? "").searchParams.get(
		"rd",
	);
	return await withKey(`/app-auth?rd=${encodeURIComponent(rd ?? "")}`, key);
}

async function setDisabled(disabled: boolean): Promise<void> {
	const updated = await client.PATCH("/service-accounts/{accountId}", {
		body: { disabled },
		params: { path: { accountId: account.id } },
	});
	expect(expectOk(updated.data, updated.response).disabled).toBe(disabled);
}

beforeAll(async () => {
	client = apiClient();
	cleanup = new ServiceCleanup(client);
	adminCookie = cookiesOf(
		await post("/api/v1/auth/sign-in/email", {
			email: ADMIN_EMAIL,
			password: ADMIN_PASSWORD,
		}),
	);

	const created = await client.POST("/service-accounts", {
		body: { name: "IT e2e runner" },
	});
	account = expectOk(created.data, created.response);
	const minted = await client.POST("/service-accounts/{accountId}/keys", {
		body: { name: "CI" },
		params: { path: { accountId: account.id } },
	});
	accountKey = expectOk(minted.data, minted.response).key;

	const suffix = Date.now().toString(36);
	const parent = await client.POST("/services", {
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
			name: `IT service account wall ${suffix}`,
			privileged: false,
			pullPolicy: "missing",
			restartPolicy: "no",
			slug: `it-sa-wall-${suffix}`,
			tag: "alpine",
		},
	});
	const service = expectOk(parent.data, parent.response);
	cleanup.track(service.id);
	const patched = await client.PATCH("/services/{serviceId}", {
		body: {
			previewAuthAllowedUserIds: [account.id],
			previewAuthProviders: ["password"],
			previewAuthRequired: true,
			previewsEnabled: true,
		},
		params: { path: { serviceId: service.id } },
	});
	expectOk(patched.data, patched.response);
	const preview = await client.PUT(
		"/services/{serviceId}/previews/{prNumber}",
		{
			body: { tag: "alpine", title: "Checkout" },
			params: { path: { prNumber: "12", serviceId: service.id } },
		},
	);
	previewId = expectOk(preview.data, preview.response).id;
});

afterAll(async () => {
	await cleanup.cleanupAll();
	await client.DELETE("/service-accounts/{accountId}", {
		params: { path: { accountId: account.id } },
	});
});

describe("service accounts", () => {
	test("its key trades for a cookie through a preview's login wall", async () => {
		const authed = await appAuthWithKey();
		expect(authed.status).toBe(302);
		const callback = new URL(authed.headers.get("location") ?? "");
		expect(callback.host).toBe(PREVIEW_HOST);
		expect(callback.pathname).toBe("/__homerun_auth/callback");

		const minted = await gateCheck(`${callback.pathname}${callback.search}`);
		expect(minted.status).toBe(302);
		expect(minted.headers.get("location")).toBe(
			`https://${PREVIEW_HOST}/checkout`,
		);
		const cookie = cookiesOf(minted);
		expect(cookie).toStartWith("homerun_app_session=");

		const through = await gateCheck("/checkout", cookie);
		expect(through.status).toBe(200);
		expect(through.headers.get("x-homerun-user")).toBe(account.id);
	});

	test("the key never reaches the app's host", async () => {
		const authed = await appAuthWithKey();
		const location = authed.headers.get("location") ?? "";
		expect(location).not.toContain(accountKey);
		const token = new URL(location).searchParams.get("token") ?? "";
		const payload = Buffer.from(token.split(".")[0], "base64url").toString();
		expect(payload).not.toContain(accountKey);
		expect(
			[...authed.headers.values()].some((value) => value.includes(accountKey)),
		).toBe(false);
	});

	test("a wall that doesn't list it refuses it", async () => {
		const other = await client.POST("/service-accounts", {
			body: { name: "IT unlisted" },
		});
		const unlisted = expectOk(other.data, other.response);
		const minted = await client.POST("/service-accounts/{accountId}/keys", {
			params: { path: { accountId: unlisted.id } },
		});
		const key = expectOk(minted.data, minted.response).key;
		try {
			const refused = await appAuthWithKey(key);
			expect(refused.status).toBe(200);
			expect(await refused.text()).toContain("allowed user list");
		} finally {
			await client.DELETE("/service-accounts/{accountId}", {
				params: { path: { accountId: unlisted.id } },
			});
		}
	});

	test("with no permissions its key reaches nothing but /app-auth", async () => {
		expect((await withKey("/api/v1/services")).status).toBe(403);
		expect((await withKey("/api/v1/notifications")).status).toBe(403);
		expect((await withKey("/api/v1/service-accounts")).status).toBe(403);
		expect((await withKey("/profile")).status).toBe(403);
	});

	test("granted permissions open exactly those areas", async () => {
		const granted = await client.PATCH("/service-accounts/{accountId}", {
			body: { permissions: { services: "read" } },
			params: { path: { accountId: account.id } },
		});
		expectOk(granted.data, granted.response);
		try {
			expect((await withKey("/api/v1/services")).status).toBe(200);
			expect((await withKey("/api/v1/stacks")).status).toBe(403);
		} finally {
			await client.PATCH("/service-accounts/{accountId}", {
				body: { permissions: {} },
				params: { path: { accountId: account.id } },
			});
		}
	});

	test("it can't sign in by password, even with one set", async () => {
		const set = await post(
			"/api/v1/auth/admin/set-user-password",
			{ newPassword: "service-account-password-1234", userId: account.id },
			adminCookie,
		);
		expect(set.status, await set.clone().text()).toBe(200);

		const signIn = await post("/api/v1/auth/sign-in/email", {
			email: `${account.id}@service-account.homerun.invalid`,
			password: "service-account-password-1234",
		});
		expect(signIn.status).not.toBe(200);
		expect(cookiesOf(signIn)).not.toContain("session_token");
	});

	test("it can't sign in by emailed code: none is ever sent", async () => {
		const { origin } = integrationContext();
		const sink = startMailSink();
		const saveSmtp = (fields: Record<string, string>) =>
			nativeFetch(`${origin}/settings/email?/updateSmtp`, {
				body: new URLSearchParams(fields),
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie: adminCookie,
					origin,
					"x-sveltekit-action": "true",
				},
				method: "POST",
			});
		const email = `${account.id}@service-account.homerun.invalid`;
		try {
			const saved = await saveSmtp({
				smtpEnabled: "on",
				smtpFrom: "homerun@integration.test",
				smtpHost: "127.0.0.1",
				smtpPassword: "sink-password",
				smtpPort: String(sink.port),
				smtpUser: "sink",
			});
			expect(saved.status).toBe(200);
			const sent = await post("/api/v1/auth/email-otp/send-verification-otp", {
				email,
				type: "sign-in",
			});
			expect(sent.status).toBe(200);
			expect(sink.messages).toHaveLength(0);
			const signIn = await post("/api/v1/auth/sign-in/email-otp", {
				email,
				otp: "123456",
			});
			expect(signIn.status).not.toBe(200);
		} finally {
			await saveSmtp({});
			sink.stop();
		}
	});

	test("its key is refused once it's disabled, and works again once enabled", async () => {
		await setDisabled(true);
		try {
			const refused = await appAuthWithKey();
			expect(refused.status).toBe(403);
			expect(await refused.text()).toContain("disabled");
		} finally {
			await setDisabled(false);
		}
		expect((await appAuthWithKey()).status).toBe(302);
	});

	test("every use of its key lands in the audit log under its name", async () => {
		await withKey("/api/v1/stacks");
		const listed = await client.GET("/service-accounts/{accountId}/activity", {
			params: { path: { accountId: account.id } },
		});
		const entries = expectOk(listed.data, listed.response);
		expect(entries.every((entry) => entry.actorName === "IT e2e runner")).toBe(
			true,
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				action: "api.request",
				detail: "GET /api/v1/stacks",
				status: 403,
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({ action: "gate.handshake", status: 302 }),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				detail: expect.stringContaining("refused, account disabled"),
			}),
		);
	});

	test("a revoked key stops working", async () => {
		const minted = await client.POST("/service-accounts/{accountId}/keys", {
			body: { expiresInDays: null },
			params: { path: { accountId: account.id } },
		});
		const created = expectOk(minted.data, minted.response);
		expect(created.expiresAt).toBeNull();
		expect((await appAuthWithKey(created.key)).status).toBe(302);
		const revoked = await client.DELETE(
			"/service-accounts/{accountId}/keys/{keyId}",
			{ params: { path: { accountId: account.id, keyId: created.id } } },
		);
		expectOk(revoked.data, revoked.response);
		expect((await withKey("/app-auth?rd=x", created.key)).status).toBe(401);
	});
});
