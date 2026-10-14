import { describe, expect, test } from "bun:test";
import {
	callbackUrlProblem,
	environmentProblem,
	matchesCallback,
	mcpAllowed,
	mcpResource,
	oidcClaimsFor,
	oidcDiscoveryUrl,
	oidcEndpointBase,
	oidcIssuer,
	originProblem,
	rebaseOnOrigin,
	registeredCallbacks,
	tokenRequestCredentials,
} from "../../../src/lib/oidc-provider";

const ada = {
	email: "ada@example.com",
	emailVerified: true,
	image: "https://example.com/ada.png",
	name: "Ada Lovelace",
	role: "admin",
};

describe("mcpAllowed", () => {
	test("HTTPS or loopback HTTP only, never a LAN IP over HTTP", () => {
		expect(mcpAllowed("https://homerun.example.com")).toBe(true);
		expect(mcpAllowed("http://localhost:5173")).toBe(true);
		expect(mcpAllowed("http://127.0.0.1:3000")).toBe(true);
		expect(mcpAllowed("http://[::1]:3000")).toBe(true);
		expect(mcpAllowed("http://app.localhost")).toBe(true);
		expect(mcpAllowed("http://192.168.1.20:3000")).toBe(false);
		expect(mcpAllowed("http://homerun.example.com")).toBe(false);
		expect(mcpAllowed("not a url")).toBe(false);
	});
});

describe("mcpResource", () => {
	test("is the MCP endpoint's URL, ignoring a trailing slash", () => {
		expect(mcpResource("https://homerun.example.com/")).toBe(
			"https://homerun.example.com/api/v1/mcp",
		);
	});
});

describe("oidcIssuer / oidcDiscoveryUrl / oidcEndpointBase", () => {
	test("the issuer is <dashboard>/issuer, the endpoints stay under the auth base path", () => {
		expect(oidcIssuer("https://homerun.example.com/")).toBe(
			"https://homerun.example.com/issuer",
		);
		expect(oidcDiscoveryUrl("https://homerun.example.com")).toBe(
			"https://homerun.example.com/issuer/.well-known/openid-configuration",
		);
		expect(oidcEndpointBase("https://homerun.example.com/")).toBe(
			"https://homerun.example.com/api/v1/auth",
		);
	});
});

describe("callbackUrlProblem", () => {
	test("https anywhere, http loopback only where localhost is allowed", () => {
		expect(callbackUrlProblem("https://app.example.com/cb", false)).toBeNull();
		expect(callbackUrlProblem("http://app.example.com/cb", false)).toContain(
			"https",
		);
		expect(callbackUrlProblem("http://localhost:3000/cb", false)).toContain(
			"allows localhost",
		);
		expect(callbackUrlProblem("http://127.0.0.1:3000/cb", true)).toBeNull();
		expect(callbackUrlProblem("https://localhost/cb", true)).toContain("http");
		expect(callbackUrlProblem("https://app.example.com/cb#x", true)).toContain(
			"fragment",
		);
		expect(callbackUrlProblem("app.example.com/cb", true)).toContain(
			"full URL",
		);
	});
});

describe("originProblem", () => {
	test("only scheme, host and port, localhost only where allowed", () => {
		expect(originProblem("https://app.example.com", false)).toBeNull();
		expect(originProblem("https://app.example.com/", false)).toBeNull();
		expect(originProblem("https://app.example.com/path", false)).toContain(
			"no path",
		);
		expect(originProblem("http://localhost:5173", false)).toContain(
			"allows localhost",
		);
		expect(originProblem("http://localhost:5173", true)).toBeNull();
	});
});

describe("registeredCallbacks", () => {
	test("unions the environments and adds the test callback on an https dashboard", () => {
		expect(
			registeredCallbacks(
				[
					{ redirectUris: ["https://a.example.com/cb"] },
					{
						redirectUris: [
							"https://a.example.com/cb",
							"https://b.example.com/cb",
						],
					},
				],
				"https://homerun.example.com",
			),
		).toEqual({
			applicationType: "web",
			redirectUris: [
				"https://a.example.com/cb",
				"https://b.example.com/cb",
				"https://homerun.example.com/idp/test-callback",
			],
		});
	});

	test("a loopback callback makes it a native client, a plain-http LAN dashboard gets no test callback", () => {
		expect(
			registeredCallbacks(
				[{ redirectUris: ["http://localhost:3000/cb"] }],
				"http://192.168.1.10:3000",
			),
		).toEqual({
			applicationType: "native",
			redirectUris: ["http://localhost:3000/cb"],
		});
	});
});

describe("matchesCallback", () => {
	test("exact, or a loopback IP on another port", () => {
		expect(
			matchesCallback("https://a.example.com/cb", "https://a.example.com/cb"),
		).toBe(true);
		expect(
			matchesCallback(
				"https://a.example.com/cb",
				"https://a.example.com/other",
			),
		).toBe(false);
		expect(
			matchesCallback("http://127.0.0.1:3000/cb", "http://127.0.0.1:4000/cb"),
		).toBe(true);
		expect(
			matchesCallback("http://localhost:3000/cb", "http://localhost:4000/cb"),
		).toBe(false);
	});
});

describe("tokenRequestCredentials", () => {
	test("reads HTTP Basic, form-decoding each half, else the body", () => {
		const basic = `Basic ${Buffer.from("my%20app:s%3Acret").toString("base64")}`;
		expect(tokenRequestCredentials(basic, new URLSearchParams())).toEqual({
			clientId: "my app",
			secret: "s:cret",
		});
		expect(
			tokenRequestCredentials(
				null,
				new URLSearchParams({ client_id: "c", client_secret: "s" }),
			),
		).toEqual({ clientId: "c", secret: "s" });
	});
});

describe("oidcClaimsFor", () => {
	test("only emits what the granted scopes cover", () => {
		expect(oidcClaimsFor(ada, ["openid"])).toEqual({});
		expect(oidcClaimsFor(ada, ["openid", "email"])).toEqual({
			email: "ada@example.com",
			email_verified: true,
		});
	});

	test("profile carries the name, a username and the picture", () => {
		expect(oidcClaimsFor(ada, ["profile"])).toEqual({
			name: "Ada Lovelace",
			picture: "https://example.com/ada.png",
			preferred_username: "ada",
		});
	});

	test("groups carries the Homerun role", () => {
		expect(oidcClaimsFor(ada, ["groups"])).toEqual({ groups: ["admin"] });
		expect(oidcClaimsFor({ ...ada, role: null }, ["groups"])).toEqual({
			groups: [],
		});
	});
});

describe("rebaseOnOrigin", () => {
	test("moves a request pinned to the installer's IP onto the dashboard's origin", async () => {
		const request = new Request(
			"http://203.0.113.10:3000/api/v1/auth/oauth2/token?x=1",
			{
				body: "grant_type=authorization_code",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			},
		);
		const rebased = rebaseOnOrigin(request, "https://homerun.example.com");
		expect(rebased.url).toBe(
			"https://homerun.example.com/api/v1/auth/oauth2/token?x=1",
		);
		expect(rebased.method).toBe("POST");
		expect(rebased.headers.get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(await rebased.text()).toBe("grant_type=authorization_code");
	});

	test("returns the same request when it's already on that origin", () => {
		const request = new Request("https://homerun.example.com/api/v1/auth/jwks");
		expect(rebaseOnOrigin(request, "https://homerun.example.com/")).toBe(
			request,
		);
	});
});

describe("environmentProblem", () => {
	const production = {
		allowedOrigins: ["https://app.example.com"],
		allowLocalhost: false,
		name: "production",
		redirectUris: ["https://app.example.com/callback"],
	};

	test("accepts a valid environment", () => {
		expect(environmentProblem(production)).toBeNull();
	});

	test("refuses a bad name, no callback, and callbacks or origins its localhost switch rules out", () => {
		expect(environmentProblem({ ...production, name: "" })).toContain(
			"Name the environment",
		);
		expect(environmentProblem({ ...production, name: "a/b" })).toContain(
			"Name the environment",
		);
		expect(environmentProblem({ ...production, redirectUris: [] })).toContain(
			"at least one callback URL",
		);
		expect(
			environmentProblem({
				...production,
				redirectUris: ["http://localhost:3000/callback"],
			}),
		).toStartWith("http://localhost:3000/callback: ");
		expect(
			environmentProblem({
				...production,
				allowedOrigins: ["http://app.example.com"],
			}),
		).toStartWith("http://app.example.com: ");
		expect(
			environmentProblem({
				...production,
				allowLocalhost: true,
				allowedOrigins: ["http://localhost:5173"],
				redirectUris: ["http://localhost:3000/callback"],
			}),
		).toBeNull();
	});
});
