import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectOk } from "./support/assert";
import type { ApiClient } from "./support/client";
import { apiClient } from "./support/context";

let client: ApiClient;
let instance: Record<string, unknown>;
let smtp: Record<string, unknown>;
let authentication: Record<string, unknown>;
let errorPages: Record<string, unknown>;
let ipBans: Record<string, unknown>;

beforeAll(async () => {
	client = apiClient();
	const [instanceRes, smtpRes, authRes, pagesRes, bansRes] = await Promise.all([
		client.GET("/instance/settings"),
		client.GET("/instance/smtp"),
		client.GET("/authentication/settings"),
		client.GET("/instance/error-pages"),
		client.GET("/instance/ip-bans"),
	]);
	instance = expectOk(instanceRes.data, instanceRes.response);
	smtp = expectOk(smtpRes.data, smtpRes.response);
	authentication = expectOk(authRes.data, authRes.response);
	errorPages = expectOk(pagesRes.data, pagesRes.response);
	ipBans = expectOk(bansRes.data, bansRes.response);
});

afterAll(async () => {
	await client.PATCH("/instance/settings", {
		body: {
			cpuSoftThreshold: instance.cpuSoftThreshold as number,
			defaultUiMode: instance.defaultUiMode as "advanced",
			resourceAlertSustainSeconds:
				instance.resourceAlertSustainSeconds as number,
			retainedImagesPerService: instance.retainedImagesPerService as number,
			updateChannel: instance.updateChannel as "stable",
		},
	});
	await client.PATCH("/instance/smtp", {
		body: { from: smtp.from as string | null },
	});
	await client.PATCH("/authentication/settings", {
		body: {
			magicLink: authentication.magicLink as boolean,
			preferredSignInMethods: authentication.preferredSignInMethods as string[],
		},
	});
	await client.PATCH("/instance/error-pages", {
		body: {
			accentColor: errorPages.accentColor as string | null,
			brandName: errorPages.brandName as string,
			pageTexts: errorPages.pageTexts as Record<string, string>,
		},
	});
	await client.PATCH("/instance/ip-bans", {
		body: {
			threshold: ipBans.threshold as number,
			windowMinutes: ipBans.windowMinutes as number,
		},
	});
});

describe("instance settings", () => {
	test("PATCH changes the fields sent, keeps the rest and GET reads them back", async () => {
		const patched = await client.PATCH("/instance/settings", {
			body: {
				cpuSoftThreshold: 70,
				defaultUiMode: "simple",
				resourceAlertSustainSeconds: 120,
				retainedImagesPerService: 7,
				updateChannel: "canary",
			},
		});
		const body = expectOk(patched.data, patched.response);
		expect(body).toMatchObject({
			cpuHardThreshold: instance.cpuHardThreshold,
			cpuSoftThreshold: 70,
			dashboardUrl: instance.dashboardUrl,
			defaultUiMode: "simple",
			resourceAlertSustainSeconds: 120,
			retainedImagesPerService: 7,
			updateChannel: "canary",
		});
		const read = await client.GET("/instance/settings");
		expect(expectOk(read.data, read.response)).toEqual(body);
	});

	test("refuses what the settings page refuses, before saving", async () => {
		const retained = await client.PATCH("/instance/settings", {
			body: { retainedImagesPerService: 999 },
		});
		expect(retained.response.status).toBe(400);
		expect(JSON.stringify(retained.error)).toContain("images per service");
		const domain = await client.PATCH("/instance/settings", {
			body: { baseDomain: "not a domain!" },
		});
		expect(domain.response.status).toBe(400);
		const thresholds = await client.PATCH("/instance/settings", {
			body: { memoryHardThreshold: 50, memorySoftThreshold: 90 },
		});
		expect(thresholds.response.status).toBe(400);
		const read = await client.GET("/instance/settings");
		expect(expectOk(read.data, read.response)).toMatchObject({
			baseDomain: instance.baseDomain,
			memoryHardThreshold: instance.memoryHardThreshold,
		});
	});
});

describe("SMTP settings", () => {
	test("PATCH keeps the stored password and never returns it", async () => {
		const patched = await client.PATCH("/instance/smtp", {
			body: { from: "Homerun <settings-api@integration.test>" },
		});
		const body = expectOk(patched.data, patched.response);
		expect(body.from).toBe("Homerun <settings-api@integration.test>");
		expect(body.passwordSet).toBe(smtp.passwordSet as boolean);
		expect(body.host).toBe(smtp.host as string | null);
		expect(body).not.toHaveProperty("password");
	});
});

describe("authentication settings", () => {
	test("PATCH switches emailed sign-in and the featured methods", async () => {
		const patched = await client.PATCH("/authentication/settings", {
			body: {
				magicLink: !authentication.magicLink,
				preferredSignInMethods: ["passkey", "password", "passkey"],
			},
		});
		expect(expectOk(patched.data, patched.response)).toMatchObject({
			emailOtp: authentication.emailOtp,
			magicLink: !authentication.magicLink,
			preferredSignInMethods: ["passkey", "password"],
			requireTwoFactor: authentication.requireTwoFactor,
		});
	});
});

describe("TLS settings", () => {
	test("reads the certificate's details and refuses an invalid one", async () => {
		const read = await client.GET("/instance/tls");
		expect(expectOk(read.data, read.response)).toHaveProperty("installed");
		const invalid = await client.PATCH("/instance/tls", {
			body: { certificate: "not a certificate", privateKey: "not a key" },
		});
		expect(invalid.response.status).toBe(400);
		expect(JSON.stringify(invalid.error)).toContain("PEM certificate");
	});
});

describe("error pages", () => {
	test("PATCH sets the branding and the page texts set", async () => {
		const patched = await client.PATCH("/instance/error-pages", {
			body: {
				accentColor: "#123456",
				brandName: "Acme",
				pageTexts: { notFoundTitle: "Gone fishing" },
			},
		});
		expect(expectOk(patched.data, patched.response)).toMatchObject({
			accentColor: "#123456",
			brandName: "Acme",
			pageTexts: { notFoundTitle: "Gone fishing" },
			showPoweredBy: errorPages.showPoweredBy,
		});
		const invalid = await client.PATCH("/instance/error-pages", {
			body: { accentColor: "red" },
		});
		expect(invalid.response.status).toBe(400);
	});
});

describe("IP ban settings", () => {
	test("PATCH changes the threshold and window and refuses out-of-range values", async () => {
		const patched = await client.PATCH("/instance/ip-bans", {
			body: { threshold: 25, windowMinutes: 30 },
		});
		expect(expectOk(patched.data, patched.response)).toMatchObject({
			durationHours: ipBans.durationHours,
			threshold: 25,
			windowMinutes: 30,
		});
		const invalid = await client.PATCH("/instance/ip-bans", {
			body: { threshold: 0 },
		});
		expect(invalid.response.status).toBe(400);
	});
});

describe("registry", () => {
	test("settings read back and an empty PATCH changes nothing", async () => {
		const read = await client.GET("/registry/settings");
		const before = expectOk(read.data, read.response);
		const patched = await client.PATCH("/registry/settings", { body: {} });
		expect(expectOk(patched.data, patched.response)).toEqual(before);
	});

	test("a token's secret is only in its create response", async () => {
		const created = await client.POST("/registry/tokens", {
			body: { username: "settings-api-ci" },
		});
		const token = expectOk(created.data, created.response);
		expect(created.response.status).toBe(201);
		expect(token.secret.length).toBeGreaterThan(10);
		const read = await client.GET("/registry/tokens/{tokenId}", {
			params: { path: { tokenId: token.id } },
		});
		const fetched = expectOk(read.data, read.response);
		expect(fetched.username).toBe("settings-api-ci");
		expect(fetched).not.toHaveProperty("secret");
		const list = await client.GET("/registry/tokens");
		expect(
			expectOk(list.data, list.response).map((entry) => entry.id),
		).toContain(token.id);
		const taken = await client.POST("/registry/tokens", {
			body: { username: "settings-api-ci" },
		});
		expect(taken.response.status).toBe(400);
		const revoked = await client.DELETE("/registry/tokens/{tokenId}", {
			params: { path: { tokenId: token.id } },
		});
		expect(revoked.response.status).toBe(204);
		const gone = await client.GET("/registry/tokens/{tokenId}", {
			params: { path: { tokenId: token.id } },
		});
		expect(gone.response.status).toBe(404);
	});
});
