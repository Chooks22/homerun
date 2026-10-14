import { describe, expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { REDACTED } from "../../../src/lib/server/mcp-redact";
import { createHomerunMcpServer } from "../../../src/lib/server/mcp-server";

interface Call {
	body?: unknown;
	method: string;
	path: string;
}

interface ToolResult {
	content: { text: string }[];
	isError?: boolean;
}

function harness(answer: (call: Call) => Response = () => Response.json([])) {
	const calls: Call[] = [];
	const handler = createMcpHandler(() =>
		createHomerunMcpServer(async (method, path, body) => {
			const call = { body, method, path };
			calls.push(call);
			return answer(call);
		}),
	);
	async function rpc(method: string, params?: unknown): Promise<unknown> {
		const res = await handler.fetch(
			new Request("http://localhost/api/v1/mcp", {
				body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				method: "POST",
			}),
		);
		const data = (await res.text())
			.split("\n")
			.find((line) => line.startsWith("data: "));
		const message = JSON.parse(data?.slice(6) ?? "{}") as {
			error?: unknown;
			result?: unknown;
		};
		if (message.error) {
			throw new Error(JSON.stringify(message.error));
		}
		return message.result;
	}
	return {
		call: (name: string, args: Record<string, unknown> = {}) =>
			rpc("tools/call", { arguments: args, name }) as Promise<ToolResult>,
		calls,
	};
}

const stored = {
	env: { API_TOKEN: "s3cret", MODE: "dev" },
	id: "ws1",
	name: "Box",
};

describe("workstation MCP tools", () => {
	const cases: [string, Record<string, unknown>, Call][] = [
		[
			"list_workstations",
			{ search: "box", state: "running" },
			{
				method: "GET",
				path: "/workstations?perPage=100&q=box&state=running",
			},
		],
		[
			"get_workstation",
			{ workstationId: "ws1" },
			{ method: "GET", path: "/workstations/ws1" },
		],
		[
			"create_workstation",
			{ authProviders: ["password"], authRequired: true, name: "Box" },
			{
				body: { authProviders: ["password"], authRequired: true, name: "Box" },
				method: "POST",
				path: "/workstations",
			},
		],
		[
			"update_workstation",
			{ authAllowedEmails: ["*@example.com"], workstationId: "ws1" },
			{
				body: { authAllowedEmails: ["*@example.com"] },
				method: "PATCH",
				path: "/workstations/ws1",
			},
		],
		[
			"start_workstation",
			{ workstationId: "ws1" },
			{
				body: { desiredState: "running" },
				method: "PATCH",
				path: "/workstations/ws1",
			},
		],
		[
			"recreate_workstation",
			{ workstationId: "ws 1" },
			{ method: "POST", path: "/workstations/ws%201/recreate" },
		],
		[
			"stop_workstation",
			{ workstationId: "ws1" },
			{
				body: { desiredState: "stopped" },
				method: "PATCH",
				path: "/workstations/ws1",
			},
		],
		[
			"delete_workstation",
			{ workstationId: "ws1" },
			{ method: "DELETE", path: "/workstations/ws1" },
		],
		[
			"delete_workstation",
			{ deleteVolume: true, workstationId: "ws1" },
			{ method: "DELETE", path: "/workstations/ws1?volume=true" },
		],
		[
			"list_workstation_presets",
			{},
			{ method: "GET", path: "/workstation-presets" },
		],
		[
			"get_workstation_preset",
			{ presetId: "p1" },
			{ method: "GET", path: "/workstation-presets/p1" },
		],
		[
			"create_workstation_preset",
			{
				authProviders: ["password"],
				authRequired: true,
				image: "codercom/code-server:4",
				name: "Node",
			},
			{
				body: {
					authProviders: ["password"],
					authRequired: true,
					image: "codercom/code-server:4",
					name: "Node",
				},
				method: "POST",
				path: "/workstation-presets",
			},
		],
		[
			"update_workstation_preset",
			{ authAllowedGroups: ["dev"], description: "go", presetId: "p1" },
			{
				body: { authAllowedGroups: ["dev"], description: "go" },
				method: "PATCH",
				path: "/workstation-presets/p1",
			},
		],
		[
			"delete_workstation_preset",
			{ presetId: "p1" },
			{ method: "DELETE", path: "/workstation-presets/p1" },
		],
	];

	for (const [tool, args, expected] of cases) {
		test(`${tool} ${JSON.stringify(args)}`, async () => {
			const mcp = harness();
			const result = await mcp.call(tool, args);
			expect(result.isError).toBeFalsy();
			expect(mcp.calls).toEqual([expected]);
		});
	}

	test("list_workstations answers a summary", async () => {
		const mcp = harness(() =>
			Response.json([{ ...stored, desiredState: "running", slug: "box" }]),
		);
		const result = await mcp.call("list_workstations");
		expect(JSON.parse(result.content[0].text)).toEqual([
			expect.objectContaining({ desiredState: "running", id: "ws1" }),
		]);
		expect(result.content[0].text).not.toContain("s3cret");
	});

	test("reads redact a workstation's and a preset's secret-looking env", async () => {
		const mcp = harness(({ path }) =>
			path === "/workstation-presets"
				? Response.json([stored])
				: Response.json(stored),
		);
		for (const [tool, args] of [
			["get_workstation", { workstationId: "ws1" }],
			["list_workstation_presets", {}],
		] as const) {
			const text = (await mcp.call(tool, args)).content[0].text;
			expect(text).not.toContain("s3cret");
			expect(text).toContain(REDACTED);
			expect(text).toContain('"MODE":"dev"');
		}
	});

	test("update_workstation merges env changes and keeps a value sent back redacted", async () => {
		const mcp = harness(() => Response.json(stored));
		const result = await mcp.call("update_workstation", {
			env: { API_TOKEN: REDACTED, MODE: null, NEW: "1" },
			workstationId: "ws1",
		});
		expect(result.isError).toBeFalsy();
		expect(mcp.calls[1]).toEqual({
			body: { env: { API_TOKEN: "s3cret", NEW: "1" } },
			method: "PATCH",
			path: "/workstations/ws1",
		});
	});

	test("update_workstation refuses a placeholder that matches nothing stored", async () => {
		const mcp = harness(() => Response.json(stored));
		const result = await mcp.call("update_workstation", {
			env: { OTHER_TOKEN: REDACTED },
			workstationId: "ws1",
		});
		expect(result.isError).toBe(true);
		expect(mcp.calls.map((call) => call.method)).toEqual(["GET"]);
	});
});
