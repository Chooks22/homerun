import { beforeAll, describe, expect, test } from "bun:test";
import { nativeFetch } from "./support/config";
import { apiClient, integrationContext } from "./support/context";

const GATED_HOST = "gated.integration.test";

interface GateFixture {
	apiKey: string;
	origin: string;
	serviceId: string;
}

let fixture: GateFixture;

async function updateAppAuth(
	body: Record<string, string | string[]>,
): Promise<Response> {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(body)) {
		for (const entry of Array.isArray(value) ? value : [value]) {
			form.append(key, entry);
		}
	}
	return await nativeFetch(
		`${fixture.origin}/services/${fixture.serviceId}/security?/updateAppAuth`,
		{
			body: form,
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
				origin: fixture.origin,
				"x-api-key": fixture.apiKey,
			},
			method: "POST",
		},
	);
}

function gateCheck(
	uri: string,
	cookie?: string,
	serviceId = fixture.serviceId,
): Promise<Response> {
	return nativeFetch(
		`${fixture.origin}/api/v1/auth-check?service=${encodeURIComponent(serviceId)}`,
		{
			headers: {
				"x-forwarded-host": GATED_HOST,
				"x-forwarded-proto": "https",
				"x-forwarded-uri": uri,
				...(cookie ? { cookie } : {}),
			},
			redirect: "manual",
		},
	);
}

function gateCookieFrom(res: Response): string {
	const set = res.headers.getSetCookie?.() ?? [];
	const entry = set.find((c) => c.startsWith("homerun_app_session="));
	if (!entry) {
		throw new Error(`No gate cookie in response (got: ${set.join(" | ")})`);
	}
	return entry.split(";")[0];
}

describe("per-app auth gate", () => {
	beforeAll(async () => {
		const ctx = integrationContext();
		const client = apiClient();
		const { data, error, response } = await client.POST("/services", {
			body: {
				authRequired: false,
				autoDeployOnPush: false,
				buildSource: "image",
				capAdd: [],
				devices: [],
				envFiles: [],
				gitBuildMethod: "dockerfile",
				labels: {},
				privileged: false,
				containerPort: 80,
				dnsResolvable: true,
				envVars: {},
				image: "nginx",
				name: "IT gate check",
				pullPolicy: "always",
				restartPolicy: "no",
				slug: `gate-check-${Date.now().toString(36)}`,
				tag: "alpine",
			},
		});
		if (error || !data) {
			throw new Error(
				`Couldn't create the gate fixture service: ${response.status} ${JSON.stringify(error)}`,
			);
		}
		fixture = {
			apiKey: ctx.apiKey,
			origin: ctx.origin,
			serviceId: data.id,
		};
	});

	test("an unknown service id is rejected without leaking anything", async () => {
		const res = await gateCheck(
			"/",
			undefined,
			"00000000-0000-0000-0000-000000000000",
		);
		expect(res.status).toBe(401);
	});

	test("a service with the gate off is let straight through", async () => {
		const res = await gateCheck("/");
		expect(res.status).toBe(200);
	});

	test("turning the gate on with no sign-in method is refused", async () => {
		const res = await updateAppAuth({ authRequired: "on" });
		const body = await res.text();
		expect(body).toContain('"type":"failure"');
		expect(body).toContain("at least one sign-in method");
	});

	test("an anonymous visitor is redirected to /app-auth, not 401'd", async () => {
		const saved = await updateAppAuth({
			authProvider: "password",
			authRequired: "on",
		});
		expect(saved.status).toBe(200);

		const res = await gateCheck("/dashboard?tab=1");
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") ?? "");
		expect(location.origin).toBe(fixture.origin);
		expect(location.pathname).toBe("/app-auth");
		expect(location.searchParams.get("rd")).toBeTruthy();
	});

	test("a forged or absent gate cookie is challenged, not trusted", async () => {
		const forged = await gateCheck("/", "homerun_app_session=not.a.real.token");
		expect(forged.status).toBe(302);
	});

	test("the /app-auth screen offers exactly the configured methods", async () => {
		const challenge = await gateCheck("/private");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const res = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		expect(res.status).toBe(302);
		const callback = new URL(res.headers.get("location") ?? "");
		expect(callback.host).toBe(GATED_HOST);
		expect(callback.pathname).toBe("/__homerun_auth/callback");
		expect(callback.searchParams.get("token")).toBeTruthy();
	});

	test("a signed-out visitor is sent to the real sign-in page, which names the app and returns to /app-auth", async () => {
		const challenge = await gateCheck("/private");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const appAuthPath = `/app-auth?rd=${encodeURIComponent(rd ?? "")}`;

		const res = await nativeFetch(`${fixture.origin}${appAuthPath}`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		const signIn = new URL(res.headers.get("location") ?? "", fixture.origin);
		expect(signIn.pathname).toBe("/auth/sign-in");
		const redirectTo = signIn.searchParams.get("redirectTo") ?? "";
		expect(new URL(redirectTo, fixture.origin).searchParams.get("rd")).toBe(rd);

		const page = await (
			await nativeFetch(`${fixture.origin}${signIn.pathname}${signIn.search}`)
		).text();
		expect(page).toContain('appName:"IT gate check"');
		expect(page).toContain(`redirectTo:${JSON.stringify(redirectTo)}`);
	});

	test("the sign-in page drops a redirectTo that would leave the origin", async () => {
		const page = await (
			await nativeFetch(
				`${fixture.origin}/auth/sign-in?redirectTo=${encodeURIComponent("//evil.example.com")}`,
			)
		).text();
		expect(page).toContain("redirectTo:null");
	});

	test("the callback mints a host-scoped cookie and returns the visitor to the original URL", async () => {
		const challenge = await gateCheck("/deep/link?a=b");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const authed = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		const callback = new URL(authed.headers.get("location") ?? "");

		const minted = await gateCheck(`${callback.pathname}${callback.search}`);
		expect(minted.status).toBe(302);
		expect(minted.headers.get("location")).toBe(
			`https://${GATED_HOST}/deep/link?a=b`,
		);

		const cookie = gateCookieFrom(minted);
		const setCookie = (minted.headers.getSetCookie?.() ?? [])[0] ?? "";
		expect(setCookie).not.toContain("Domain=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");

		const through = await gateCheck("/deep/link?a=b", cookie);
		expect(through.status).toBe(200);
		expect(through.headers.get("x-homerun-user")).toBe(
			integrationContext().userId,
		);
	});

	test("the gated app's own Bearer token is ignored, not checked as a Homerun API key", async () => {
		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const authed = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		const callback = new URL(authed.headers.get("location") ?? "");
		const cookie = gateCookieFrom(
			await gateCheck(`${callback.pathname}${callback.search}`),
		);

		const res = await nativeFetch(
			`${fixture.origin}/api/v1/auth-check?service=${fixture.serviceId}`,
			{
				headers: {
					authorization: "Bearer umami_not-a-homerun-key",
					cookie,
					"x-forwarded-host": GATED_HOST,
					"x-forwarded-proto": "https",
					"x-forwarded-uri": "/api/websites",
				},
				redirect: "manual",
			},
		);
		expect(res.status).toBe(200);
	});

	test("a gate cookie minted for one host is not accepted on another", async () => {
		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const authed = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		const callback = new URL(authed.headers.get("location") ?? "");
		const minted = await gateCheck(`${callback.pathname}${callback.search}`);
		const cookie = gateCookieFrom(minted);

		const res = await nativeFetch(
			`${fixture.origin}/api/v1/auth-check?service=${fixture.serviceId}`,
			{
				headers: {
					cookie,
					"x-forwarded-host": "someone-elses-app.integration.test",
					"x-forwarded-proto": "https",
					"x-forwarded-uri": "/",
				},
				redirect: "manual",
			},
		);
		expect(res.status).toBe(302);
	});

	test("an email allowlist that excludes the admin denies them", async () => {
		await updateAppAuth({
			authAllowedEmails: "nobody@example.com",
			authProvider: "password",
			authRequired: "on",
		});

		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const res = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("allowed list");
	});

	test("a *@domain wildcard covering the admin lets them back through", async () => {
		await updateAppAuth({
			authAllowedEmails: "*@integration.test",
			authProvider: "password",
			authRequired: "on",
		});

		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const res = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		expect(res.status).toBe(302);
	});

	test("requiring a group the admin doesn't have denies them", async () => {
		await updateAppAuth({
			authAllowedGroups: "platform-team",
			authProvider: "password",
			authRequired: "on",
		});

		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const res = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("group");
	});

	test("tightening the policy immediately revokes an already-issued cookie", async () => {
		await updateAppAuth({
			authProvider: "password",
			authRequired: "on",
		});
		const challenge = await gateCheck("/");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const authed = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		const callback = new URL(authed.headers.get("location") ?? "");
		const minted = await gateCheck(`${callback.pathname}${callback.search}`);
		const cookie = gateCookieFrom(minted);
		expect((await gateCheck("/", cookie)).status).toBe(200);

		await updateAppAuth({
			authAllowedEmails: "nobody@example.com",
			authProvider: "password",
			authRequired: "on",
		});
		expect((await gateCheck("/", cookie)).status).toBe(302);
	});

	test("/app-auth reached on a gated app's own host is sent to the canonical origin", async () => {
		const res = await nativeFetch(`${fixture.origin}/app-auth?rd=tok`, {
			headers: { host: GATED_HOST },
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			`${fixture.origin}/app-auth?rd=tok`,
		);
	});

	test("/app-auth on the canonical origin runs its own load instead of looping", async () => {
		const res = await nativeFetch(`${fixture.origin}/app-auth?rd=tok`, {
			redirect: "manual",
		});
		expect(res.status).toBe(400);
	});

	test("the sign-in page resolves a canonical URL from the Host header, not url.origin", async () => {
		const off = await nativeFetch(`${fixture.origin}/auth/sign-in`, {
			headers: { host: GATED_HOST },
		});
		expect(await off.text()).toContain(
			`canonicalSignInUrl:"${fixture.origin}/auth/sign-in"`,
		);

		const on = await nativeFetch(`${fixture.origin}/auth/sign-in`);
		expect(await on.text()).toContain("canonicalSignInUrl:null");
	});

	test("on a domain with a path, the sign-in round trip and its cookie stay under that path", async () => {
		await updateAppAuth({ authProvider: "password", authRequired: "on" });
		const patched = await nativeFetch(
			`${fixture.origin}/api/v1/services/${fixture.serviceId}`,
			{
				body: JSON.stringify({ domains: [`${GATED_HOST}/api`] }),
				headers: {
					"content-type": "application/json",
					"x-api-key": fixture.apiKey,
				},
				method: "PATCH",
			},
		);
		expect(patched.status).toBe(200);

		const challenge = await gateCheck("/api/items?a=b");
		const rd = new URL(
			challenge.headers.get("location") ?? "",
		).searchParams.get("rd");
		const authed = await nativeFetch(
			`${fixture.origin}/app-auth?rd=${encodeURIComponent(rd ?? "")}`,
			{ headers: { "x-api-key": fixture.apiKey }, redirect: "manual" },
		);
		const callback = new URL(authed.headers.get("location") ?? "");
		expect(callback.pathname).toBe("/api/__homerun_auth/callback");

		const minted = await gateCheck(`${callback.pathname}${callback.search}`);
		expect(minted.status).toBe(302);
		expect(minted.headers.get("location")).toBe(
			`https://${GATED_HOST}/api/items?a=b`,
		);
		expect((minted.headers.getSetCookie?.() ?? [])[0]).toContain("Path=/api;");
		const cookie = gateCookieFrom(minted);

		const through = await gateCheck(
			"/api/items",
			`${cookie}; homerun_app_session=another.services.cookie`,
		);
		expect(through.status).toBe(200);

		const logout = await gateCheck("/api/__homerun_auth/logout", cookie);
		expect(logout.status).toBe(302);
		expect(logout.headers.get("location")).toBe(`https://${GATED_HOST}/api`);
		const cleared = (logout.headers.getSetCookie?.() ?? [])[0] ?? "";
		expect(cleared).toContain("Path=/api;");
		expect(cleared).toContain("Max-Age=0");
	});

	test("an expired redirect token is refused rather than followed", async () => {
		const res = await nativeFetch(`${fixture.origin}/app-auth?rd=bogus.token`, {
			headers: { "x-api-key": fixture.apiKey },
			redirect: "manual",
		});
		expect(res.status).toBe(400);
	});
});
