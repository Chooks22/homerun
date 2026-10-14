import { describe, expect, test } from "bun:test";
import { parse } from "devalue";
import { nativeFetch } from "./support/config";
import { integrationContext } from "./support/context";

const ADMIN_EMAIL = "admin@integration.test";
const ADMIN_PASSWORD = "integration-test-password-1234";

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
	fields: Record<string, string>,
): Promise<{ data: Record<string, unknown>; type: string }> {
	const { origin } = integrationContext();
	const res = await nativeFetch(`${origin}${path}`, {
		body: new URLSearchParams(fields),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			origin,
			"x-sveltekit-action": "true",
		},
		method: "POST",
	});
	const body = (await res.json()) as { data: string; type: string };
	return { data: parse(body.data) as Record<string, unknown>, type: body.type };
}

function withKey(key: string, path: string, body?: unknown) {
	const { origin } = integrationContext();
	return nativeFetch(`${origin}${path}`, {
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: { "content-type": "application/json", "x-api-key": key },
		method: body === undefined ? "GET" : "POST",
	});
}

describe("scoped API keys", () => {
	test("a key only reaches the areas and levels it was created with", async () => {
		const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const created = await formAction(cookie, "/profile/api-keys/new?/create", {
			expiry: "7",
			name: "services reader",
			"permission.services": "read",
		});
		expect(created.type).toBe("success");
		const key = created.data.key as string;

		expect((await withKey(key, "/api/v1/services")).status).toBe(200);
		expect((await withKey(key, "/api/v1/stacks")).status).toBe(403);
		const write = await withKey(key, "/api/v1/stacks", { name: "refused" });
		expect(write.status).toBe(403);
	});

	test("a key needs at least one permission unless it's allowed all of them", async () => {
		const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const refused = await formAction(cookie, "/profile/api-keys/new?/create", {
			expiry: "never",
			name: "nothing",
		});
		expect(refused.type).toBe("failure");

		const everything = await formAction(
			cookie,
			"/profile/api-keys/new?/create",
			{
				allPermissions: "on",
				expiry: "never",
				name: "everything",
			},
		);
		expect(everything.type).toBe("success");
		expect(
			(await withKey(everything.data.key as string, "/api/v1/iac/projects"))
				.status,
		).toBe(200);
	});
});

describe("custom-role users", () => {
	const email = "custom@integration.test";
	const password = "custom-integration-password-1234";

	test("hold exactly the permissions they're given", async () => {
		const { origin } = integrationContext();
		const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const created = await nativeFetch(
			`${origin}/api/v1/auth/admin/create-user`,
			{
				body: JSON.stringify({
					email,
					name: "Custom",
					password,
					role: "developer",
				}),
				headers: {
					"content-type": "application/json",
					cookie: adminCookie,
					origin,
				},
				method: "POST",
			},
		);
		expect(created.status, await created.clone().text()).toBe(200);
		const { user } = (await created.json()) as { user: { id: string } };

		expect(
			(
				await formAction(adminCookie, "/users?/setRole", {
					role: "custom",
					userId: user.id,
				})
			).type,
		).toBe("success");
		expect(
			(
				await formAction(adminCookie, "/users?/setPermissions", {
					"permission.stacks": "read",
					userId: user.id,
				})
			).type,
		).toBe("success");

		const cookie = await signIn(email, password);
		const get = (path: string) =>
			nativeFetch(`${origin}${path}`, { headers: { cookie } });
		expect((await get("/api/v1/stacks")).status).toBe(200);
		expect((await get("/api/v1/services")).status).toBe(403);
		expect((await get("/services")).status).toBe(403);
	});
});

describe("banned users", () => {
	const email = "banned@integration.test";
	const password = "banned-integration-password-1234";

	test("their API keys are refused until the ban is lifted or runs out", async () => {
		const { origin } = integrationContext();
		const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
		const admin = (path: string, body: unknown) =>
			nativeFetch(`${origin}/api/v1/auth/admin/${path}`, {
				body: JSON.stringify(body),
				headers: {
					"content-type": "application/json",
					cookie: adminCookie,
					origin,
				},
				method: "POST",
			});
		const created = await admin("create-user", {
			email,
			name: "Banned",
			password,
			role: "developer",
		});
		expect(created.status, await created.clone().text()).toBe(200);
		const { user } = (await created.json()) as { user: { id: string } };
		try {
			const minted = await formAction(
				await signIn(email, password),
				"/profile/api-keys/new?/create",
				{ allPermissions: "on", expiry: "7", name: "before the ban" },
			);
			expect(minted.type).toBe("success");
			const key = minted.data.key as string;
			expect((await withKey(key, "/api/v1/services")).status).toBe(200);

			expect((await admin("ban-user", { userId: user.id })).status).toBe(200);
			const refused = await withKey(key, "/api/v1/services");
			expect(refused.status).toBe(403);
			expect(await refused.text()).toContain("banned");

			expect((await admin("unban-user", { userId: user.id })).status).toBe(200);
			expect((await withKey(key, "/api/v1/services")).status).toBe(200);

			expect(
				(await admin("ban-user", { banExpiresIn: 1, userId: user.id })).status,
			).toBe(200);
			expect((await withKey(key, "/api/v1/services")).status).toBe(403);
			await Bun.sleep(1500);
			expect((await withKey(key, "/api/v1/services")).status).toBe(200);
		} finally {
			await admin("remove-user", { userId: user.id });
		}
	});
});
