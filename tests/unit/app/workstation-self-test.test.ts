import { describe, expect, test } from "bun:test";
import { containerCheck, routeCheck } from "#lib/workstation-self-test.js";

describe("containerCheck", () => {
	test("a running container passes", () => {
		expect(containerCheck({ hostPort: 0, state: "running" }).ok).toBe(true);
	});

	test("a failed start carries its error", () => {
		const check = containerCheck({
			error: "couldn't pull the image",
			hostPort: 0,
			state: "failed",
		});
		expect(check.ok).toBe(false);
		expect(check.detail).toContain("couldn't pull the image");
	});
});

describe("routeCheck", () => {
	test("a redirect to the IDE's login passes", () => {
		expect(routeCheck("ws.example.com", 302, 8080).ok).toBe(true);
	});

	test("a 404 means no router matches the host", () => {
		const check = routeCheck("ws.example.com", 404, 8080);
		expect(check.ok).toBe(false);
		expect(check.detail).toContain("no router");
	});

	test("a 502 names the IDE port", () => {
		const check = routeCheck("ws.example.com", 502, 8080);
		expect(check.ok).toBe(false);
		expect(check.detail).toContain("port 8080");
	});
});
