import { afterEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { UserService } = await import("../../../src/lib/services/user.service");
const { gatedService, invalidateGatedService } = await import(
	"../../../src/lib/server/gated-service-cache"
);
const { parseLoginWallForm, splitList } = await import(
	"../../../src/lib/server/login-wall-form"
);
const { loginWallAvailability, loginWallOptions } = await import(
	"../../../src/lib/server/login-wall-options"
);

afterEach(() => restoreStubs());

const available = {
	email: { emailOtp: true, magicLink: false },
	oauthProviders: new Set(["pocket-id"]),
};
const ORIGIN = "https://homerun.example.com";

function form(entries: [string, string][]): FormData {
	const data = new FormData();
	for (const [key, value] of entries) {
		data.append(key, value);
	}
	return data;
}

describe("parseLoginWallForm", () => {
	test("reads a wall with its methods and allow-lists", () => {
		const result = parseLoginWallForm(
			form([
				["authRequired", "on"],
				["authProvider", "email-otp"],
				["authProvider", "oauth:pocket-id"],
				["authAllowedUserId", "u1"],
				["authAllowedUserId", "u1"],
				["authAllowedEmails", "a@x.io, *@client.com\na@x.io"],
				["authAllowedGroups", "reviewers"],
			]),
			available,
			ORIGIN,
		);
		expect(result).toEqual({
			policy: {
				authAllowedEmails: ["a@x.io", "*@client.com"],
				authAllowedGroups: ["reviewers"],
				authAllowedUserIds: ["u1"],
				authProviders: ["email-otp", "oauth:pocket-id"],
				authRequired: true,
			},
		});
	});

	test("refuses a method that isn't enabled here", () => {
		const result = parseLoginWallForm(
			form([
				["authRequired", "on"],
				["authProvider", "magic-link"],
			]),
			available,
			ORIGIN,
		);
		expect(result).toEqual({
			error: '"magic-link" isn\'t an enabled sign-in method on this instance.',
		});
	});

	test("refuses a wall nobody could pass or that can't redirect", () => {
		expect(
			parseLoginWallForm(form([["authRequired", "on"]]), available, ORIGIN),
		).toMatchObject({ error: expect.stringContaining("at least one") });
		expect(
			parseLoginWallForm(
				form([
					["authRequired", "on"],
					["authProvider", "email-otp"],
				]),
				available,
				null,
			),
		).toMatchObject({ error: expect.stringContaining("Dashboard URL") });
	});

	test("refuses an allowed email that isn't an address or *@domain", () => {
		expect(
			parseLoginWallForm(
				form([["authAllowedEmails", "not-an-email"]]),
				available,
				ORIGIN,
			),
		).toMatchObject({ error: expect.stringContaining("not-an-email") });
	});

	test("an open wall with no methods is fine", () => {
		expect(parseLoginWallForm(form([]), available, ORIGIN)).toMatchObject({
			policy: { authRequired: false, authProviders: [] },
		});
	});
});

describe("splitList", () => {
	test("splits on commas and newlines, trims and de-duplicates", () => {
		expect(splitList(" a , b\nb\n\n c ")).toEqual(["a", "b", "c"]);
		expect(splitList(null)).toEqual([]);
	});
});

describe("loginWallAvailability / loginWallOptions", () => {
	test("lists the enabled OAuth providers and every account", async () => {
		const original = config.auth.oauthProviders;
		config.auth.oauthProviders = [
			{ enabled: true, label: "Pocket ID", name: "pocket-id" },
			{ enabled: false, label: "", name: "off" },
		] as typeof config.auth.oauthProviders;
		stub(UserService, "listUsers", async () => [
			{
				email: "c@x.io",
				id: "u1",
				name: "Client",
				role: "app-user",
				type: "human",
			},
		]);
		try {
			const available = await loginWallAvailability();
			expect([...available.oauthProviders]).toEqual(["pocket-id"]);
			const options = await loginWallOptions();
			expect(options.oauthProviders).toEqual([
				{ label: "Pocket ID", method: "oauth:pocket-id", name: "pocket-id" },
			]);
			expect(options.users).toEqual([
				{
					email: "c@x.io",
					id: "u1",
					name: "Client",
					role: "app-user",
					type: "human",
				},
			]);
			expect((await loginWallOptions(false)).users).toEqual([]);
		} finally {
			config.auth.oauthProviders = original;
		}
	});
});

describe("gatedService", () => {
	test("caches a lookup, misses included, until invalidated", async () => {
		let reads = 0;
		stub(ServiceDTO, "get", async () => {
			reads += 1;
			return null;
		});
		expect(await gatedService("gate-1")).toBeNull();
		expect(await gatedService("gate-1")).toBeNull();
		expect(reads).toBe(1);
		invalidateGatedService("gate-1");
		await gatedService("gate-1");
		expect(reads).toBe(2);
	});
});
