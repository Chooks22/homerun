import { describe, expect, test } from "bun:test";
import {
	GATE_COOKIE_NAME,
	gateCookie,
	gatePrefix,
	readGateCookies,
	signGateToken,
	verifyGateToken,
} from "../../../src/lib/server/app-gate";
import {
	groupsAcross,
	groupsFromIdToken,
	isBanned,
} from "../../../src/lib/services/app-access.service";

const payload = {
	email: "ada@example.com",
	host: "app.example.com",
	serviceId: "svc-1",
	userId: "user-1",
};

function idTokenWith(claims: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `header.${body}.signature`;
}

describe("gate tokens", () => {
	test("a freshly signed token verifies and round-trips its payload", () => {
		const verified = verifyGateToken(signGateToken(payload, 60_000));
		expect(verified).toMatchObject(payload);
	});

	test("an expired token is rejected", () => {
		expect(verifyGateToken(signGateToken(payload, -1))).toBeNull();
	});

	test("a tampered payload is rejected", () => {
		const token = signGateToken(payload, 60_000);
		const [body, sig] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ ...payload, exp: Date.now() + 60_000, userId: "root" }),
		).toString("base64url");
		expect(verifyGateToken(`${forged}.${sig}`)).toBeNull();
		expect(verifyGateToken(`${body}.${sig}x`)).toBeNull();
	});

	test("garbage is rejected rather than throwing", () => {
		expect(verifyGateToken("")).toBeNull();
		expect(verifyGateToken("nodot")).toBeNull();
		expect(verifyGateToken("...")).toBeNull();
	});
});

describe("gate cookie", () => {
	test("reads its own value back out of a crowded Cookie header", () => {
		const header = `other=1; ${GATE_COOKIE_NAME}=abc%3D; another=2`;
		expect(readGateCookies(header)).toEqual(["abc="]);
	});

	test("returns every one when services on one host each set theirs", () => {
		const header = `${GATE_COOKIE_NAME}=api; ${GATE_COOKIE_NAME}=web`;
		expect(readGateCookies(header)).toEqual(["api", "web"]);
	});

	test("returns nothing when absent or when there is no header", () => {
		expect(readGateCookies("other=1")).toEqual([]);
		expect(readGateCookies(null)).toEqual([]);
	});

	test("never matches a cookie whose name merely ends with ours", () => {
		expect(readGateCookies(`not_${GATE_COOKIE_NAME}=nope`)).toEqual([]);
	});

	test("is scoped to the service's path prefix when it has one", () => {
		expect(gateCookie("v", true, 60)).toContain("Path=/;");
		expect(gateCookie("v", true, 60, "/api")).toContain("Path=/api;");
	});

	test("only adds Secure over https", () => {
		expect(gateCookie("v", true, 60)).toContain("Secure");
		expect(gateCookie("v", false, 60)).not.toContain("Secure");
		expect(gateCookie("v", false, 60)).toContain("HttpOnly");
	});
});

describe("group claims", () => {
	test("reads a plain groups claim", () => {
		expect([
			...groupsFromIdToken(idTokenWith({ groups: ["admins", "devs"] })),
		]).toEqual(["admins", "devs"]);
	});

	test("reads keycloak realm and resource roles", () => {
		const groups = groupsFromIdToken(
			idTokenWith({
				realm_access: { roles: ["realm-admin"] },
				resource_access: { homerun: { roles: ["app-user"] } },
			}),
		);
		expect(groups.has("realm-admin")).toBe(true);
		expect(groups.has("app-user")).toBe(true);
	});

	test("accepts a single string claim, not just an array", () => {
		expect([...groupsFromIdToken(idTokenWith({ roles: "solo" }))]).toEqual([
			"solo",
		]);
	});

	test("an undecodable token yields no groups instead of throwing", () => {
		expect(groupsFromIdToken("not-a-jwt").size).toBe(0);
		expect(groupsFromIdToken("a.!!!.c").size).toBe(0);
	});
});

describe("gate user state", () => {
	test("the Homerun role counts as a group alongside provider claims", () => {
		const groups = groupsAcross(
			[{ idToken: idTokenWith({ groups: ["devs"] }) }, { idToken: null }],
			"admin",
		);
		expect(groups.has("devs")).toBe(true);
		expect(groups.has("admin")).toBe(true);
	});

	test("a user with no role only carries provider groups", () => {
		expect([...groupsAcross([], null)]).toEqual([]);
	});

	test("a ban only counts while it hasn't expired", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		expect(isBanned({ banExpires: null, banned: true }, now)).toBe(true);
		expect(
			isBanned({ banExpires: new Date("2026-02-01"), banned: true }, now),
		).toBe(true);
		expect(
			isBanned({ banExpires: new Date("2025-12-01"), banned: true }, now),
		).toBe(false);
		expect(isBanned({ banExpires: null, banned: false }, now)).toBe(false);
		expect(isBanned({ banExpires: null, banned: null }, now)).toBe(false);
	});
});

describe("gate prefix", () => {
	const domains = [
		"app.example.com",
		"www.example.com/api",
		"www.example.com/api/v2",
	];

	test("is empty for a service reached on a bare hostname", () => {
		expect(gatePrefix(domains, "app.example.com", "/api/x")).toBe("");
	});

	test("is the path of the domain the request came in on, the longest match", () => {
		expect(gatePrefix(domains, "www.example.com", "/api")).toBe("/api");
		expect(gatePrefix(domains, "WWW.example.com:443", "/api/x")).toBe("/api");
		expect(gatePrefix(domains, "www.example.com", "/api/v2/y")).toBe("/api/v2");
	});

	test("doesn't treat a longer segment as under the prefix", () => {
		expect(gatePrefix(domains, "www.example.com", "/apifoo")).toBe("");
	});
});
