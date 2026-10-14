import { describe, expect, test } from "bun:test";
import {
	cronScheduleProblem,
	customSslChange,
	routingPatch,
} from "../../../src/lib/service-settings";
import { storageVolumeProblem } from "../../../src/lib/storage-volume-input";

const current = {
	containerPort: 80,
	defaultDomainEnabled: true,
	domainPorts: {},
	domains: [],
	primaryDomain: null,
	slug: "web",
	stripPathDomains: [],
};
const context = { baseDomain: "example.com", stackSlug: null };

describe("routingPatch", () => {
	test("does nothing when no routing field is sent", () => {
		expect(routingPatch(current, { containerPort: 81 }, context)).toBeNull();
	});

	test("keeps the current value of a field sent as undefined", () => {
		const result = routingPatch(
			current,
			{ domains: ["a.io"], slug: undefined },
			context,
		);
		expect(result && "hostnames" in result ? result.hostnames : []).toEqual([
			"web.example.com",
			"a.io",
		]);
	});

	test("normalises domains, drops the default hostname and stray ports", () => {
		const result = routingPatch(
			current,
			{
				domainPorts: { "app.io": 8080, "other.io": 9000, "www.app.io": 80 },
				domains: [" App.io ", "web.example.com", "www.app.io", "app.io"],
				primaryDomain: "WWW.app.io",
			},
			context,
		);
		expect(result).toEqual({
			hostnames: ["web.example.com", "app.io", "www.app.io"],
			patch: {
				defaultDomainEnabled: true,
				domainPorts: { "app.io": 8080 },
				domains: ["app.io", "www.app.io"],
				primaryDomain: "www.app.io",
				stripPathDomains: [],
			},
		});
	});

	test("accepts a domain with a path and keeps stripping only for listed path domains", () => {
		const result = routingPatch(
			current,
			{
				domains: ["app.io", "app.io/API/"],
				stripPathDomains: ["app.io/api", "app.io", "gone.io/api"],
			},
			context,
		);
		expect(result && "patch" in result ? result.patch : null).toMatchObject({
			domains: ["app.io", "app.io/api"],
			stripPathDomains: ["app.io/api"],
		});
	});

	test("refuses a malformed domain and no hostname at all", () => {
		expect(routingPatch(current, { domains: ["nope"] }, context)).toEqual({
			error: '"nope" isn\'t a valid domain.',
		});
		expect(
			routingPatch(current, { defaultDomainEnabled: false }, context),
		).toMatchObject({
			error: expect.stringContaining("Keep at least one domain"),
		});
	});

	test("falls back to the first hostname when the main one isn't routed", () => {
		const result = routingPatch(
			{ ...current, primaryDomain: "gone.io" },
			{ defaultDomainEnabled: true },
			{ baseDomain: "example.com", stackSlug: "apps" },
		);
		expect(
			result && "patch" in result ? result.patch.primaryDomain : null,
		).toBe("apps-web.example.com");
	});
});

describe("customSslChange", () => {
	test("sets, clears, ignores or refuses half a certificate", () => {
		expect(customSslChange({})).toBeNull();
		expect(
			customSslChange({ customSslCert: null, customSslKey: null }),
		).toEqual({
			kind: "clear",
		});
		expect(customSslChange({ customSslCert: "c", customSslKey: "k" })).toEqual({
			cert: "c",
			key: "k",
			kind: "set",
		});
		expect(customSslChange({ customSslCert: "c" })).toEqual({
			error: "Send both the certificate and its private key.",
		});
	});
});

describe("storageVolumeProblem", () => {
	test("needs a name, a kind, a source and an absolute bind path", () => {
		expect(
			storageVolumeProblem({ kind: "volume", name: " ", source: "x" }),
		).toBe("Name is required.");
		expect(storageVolumeProblem({ kind: null, name: "a", source: "x" })).toBe(
			"Choose a volume type.",
		);
		expect(storageVolumeProblem({ kind: "bind", name: "a", source: "" })).toBe(
			"Host path is required.",
		);
		expect(
			storageVolumeProblem({ kind: "volume", name: "a", source: "" }),
		).toBe("Volume name is required.");
		expect(
			storageVolumeProblem({ kind: "bind", name: "a", source: "srv" }),
		).toBe("Host path must be absolute (start with /).");
		expect(
			storageVolumeProblem({ kind: "bind", name: "a", source: "/srv" }),
		).toBeNull();
	});
});

describe("cronScheduleProblem", () => {
	const off = { cronEnabled: false, cronSchedule: "0 3 * * *" };

	test("nothing to check when neither field is sent", () => {
		expect(
			cronScheduleProblem({ cronEnabled: true, cronSchedule: null }, {}),
		).toBeNull();
	});

	test("a schedule sent as null or blank is cleared, not kept", () => {
		expect(
			cronScheduleProblem(off, { cronEnabled: true, cronSchedule: null }),
		).toContain("Invalid schedule");
		expect(
			cronScheduleProblem(off, { cronEnabled: true, cronSchedule: "" }),
		).toContain("Invalid schedule");
	});

	test("an omitted schedule keeps the stored one", () => {
		expect(cronScheduleProblem(off, { cronEnabled: true })).toBeNull();
		expect(
			cronScheduleProblem(off, { cronEnabled: true, cronSchedule: "nope" }),
		).toContain("Invalid schedule");
		expect(cronScheduleProblem(off, { cronSchedule: null })).toBeNull();
	});
});
