import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	AgentClientService,
	AgentRequestError,
} from "#lib/services/agent-client.service.js";

const agentUrl = "http://agent.test:7430";
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function respondTo(url: URL, init: RequestInit): Response {
	const authed =
		(init.headers as Record<string, string> | undefined)?.authorization ===
		"Bearer good";
	switch (url.pathname) {
		case "/v1/health":
			return json({ status: "ok", version: "1.2.3" });
		case "/v1/stats":
			return authed ? json({}) : new Response(null, { status: 401 });
		case "/v1/echo":
			return json({
				body: init.body ? JSON.parse(String(init.body)) : null,
				method: init.method,
				port: url.searchParams.get("port"),
			});
		case "/v1/empty":
			return new Response(null, { status: 200 });
		case "/v1/conflict":
			return json({ error: "already starting" }, 409);
		case "/v1/plain":
			return new Response("teapot", { status: 418 });
		case "/v1/cut":
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("cut off"));
					},
				}),
				{ status: 502 },
			);
		default:
			return json({ error: "Not found" }, 404);
	}
}

beforeEach(() => {
	globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
		const url = new URL(String(input));
		if (url.host !== "agent.test:7430") {
			throw new Error("connect ECONNREFUSED");
		}
		return respondTo(url, init);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const connection = { agentUrl, token: "good" };

describe("AgentClientService.request", () => {
	test("sends the token, body and query and decodes the answer", async () => {
		const answer = await AgentClientService.request<{
			body: unknown;
			method: string;
			port: string;
		}>(connection, "PUT", "/v1/echo", {
			body: { image: "x" },
			query: { port: "8080" },
		});
		expect(answer).toEqual({
			body: { image: "x" },
			method: "PUT",
			port: "8080",
		});
	});

	test("an empty answer is null", async () => {
		expect(
			await AgentClientService.request(connection, "POST", "/v1/empty"),
		).toBeNull();
	});

	test("a failure carries the agent's own message and status", async () => {
		const error = await AgentClientService.request(
			connection,
			"PUT",
			"/v1/conflict",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AgentRequestError);
		expect((error as AgentRequestError).status).toBe(409);
		expect((error as AgentRequestError).message).toBe("already starting");
	});

	test("an unknown route reads as an agent too old for it", async () => {
		await expect(
			AgentClientService.request(connection, "GET", "/v1/workstations/x"),
		).rejects.toThrow("Update the Homerun worker");
	});

	test("a non-JSON failure keeps its text", async () => {
		await expect(
			AgentClientService.request(connection, "GET", "/v1/plain"),
		).rejects.toThrow("teapot");
	});

	test("a body cut off mid-failure falls back to the status", async () => {
		await expect(
			AgentClientService.request(connection, "GET", "/v1/cut"),
		).rejects.toThrow("The agent answered 502.");
	});

	test("an unreachable agent says so", async () => {
		await expect(
			AgentClientService.request(
				{ agentUrl: "http://127.0.0.1:1", token: "good" },
				"GET",
				"/v1/health",
			),
		).rejects.toThrow("Couldn't reach the agent");
	});
});

describe("AgentClientService checks", () => {
	test("checkHealth answers the agent's version", async () => {
		expect(await AgentClientService.checkHealth(agentUrl)).toEqual({
			status: "ok",
			version: "1.2.3",
		});
		await expect(
			AgentClientService.checkHealth("http://127.0.0.1:1"),
		).rejects.toThrow("Couldn't reach the agent");
	});

	test("verifyToken accepts a good token and names a bad one", async () => {
		await AgentClientService.verifyToken(agentUrl, "good");
		await expect(
			AgentClientService.verifyToken(agentUrl, "bad"),
		).rejects.toThrow("rejected this token");
		await expect(
			AgentClientService.verifyToken("http://127.0.0.1:1", "good"),
		).rejects.toThrow("Couldn't reach the agent");
	});
});
