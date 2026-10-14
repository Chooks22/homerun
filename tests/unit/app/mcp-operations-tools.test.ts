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

/** An MCP server whose REST calls are recorded and answered by `answer`. */
function harness(answer: (call: Call) => Response = () => Response.json({})) {
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
		listTools: async () =>
			((await rpc("tools/list")) as { tools: { name: string }[] }).tools.map(
				(tool) => tool.name,
			),
	};
}

const cases: [string, Record<string, unknown>, Call][] = [
	[
		"get_service_version",
		{ serviceId: "svc" },
		{ method: "GET", path: "/services/svc/version" },
	],
	[
		"find_pin_tags",
		{ serviceId: "svc" },
		{ method: "GET", path: "/services/svc/version/pin" },
	],
	[
		"pin_service",
		{ local: true, serviceId: "svc", tag: "1.25.3" },
		{
			body: { local: true, tag: "1.25.3" },
			method: "POST",
			path: "/services/svc/version/pin",
		},
	],
	[
		"unpin_service",
		{ serviceId: "svc" },
		{ method: "DELETE", path: "/services/svc/version/pin" },
	],
	[
		"set_update_watch",
		{ serviceId: "svc", updateCheckEnabled: true },
		{
			body: { updateCheckEnabled: true },
			method: "PATCH",
			path: "/services/svc/version",
		},
	],
	[
		"check_service_updates",
		{ serviceId: "svc" },
		{ method: "POST", path: "/services/svc/version/check" },
	],
	[
		"apply_service_update",
		{ serviceId: "svc" },
		{ method: "POST", path: "/services/svc/version/update" },
	],
	["get_monitoring", {}, { method: "GET", path: "/monitoring?range=week" }],
	[
		"get_service_monitoring",
		{ range: "today", serviceId: "svc" },
		{ method: "GET", path: "/services/svc/monitoring?range=today" },
	],
	[
		"list_system_logs",
		{ limit: 20 },
		{ method: "GET", path: "/system/logs?limit=20" },
	],
	["list_system_containers", {}, { method: "GET", path: "/system/containers" }],
	[
		"system_container_logs",
		{ containerId: "abc" },
		{ method: "GET", path: "/system/containers/abc/logs?tail=200" },
	],
	[
		"run_docker_cleanup",
		{ action: "pruneImages", all: true },
		{
			body: { action: "pruneImages", all: true },
			method: "POST",
			path: "/system/docker-cleanup",
		},
	],
	["list_dns_connections", {}, { method: "GET", path: "/dns-connections" }],
	["list_domains", {}, { method: "GET", path: "/domains" }],
	[
		"list_dns_records",
		{ domainId: "d1" },
		{ method: "GET", path: "/domains/d1/records" },
	],
	[
		"create_dns_record",
		{ content: "1.2.3.4", domainId: "d1", name: "www", type: "A" },
		{
			body: { content: "1.2.3.4", name: "www", type: "A" },
			method: "POST",
			path: "/domains/d1/records",
		},
	],
	[
		"update_dns_record",
		{ content: "5.6.7.8", domainId: "d1", recordId: "r/1" },
		{
			body: { content: "5.6.7.8" },
			method: "PATCH",
			path: "/domains/d1/records/r%2F1",
		},
	],
	[
		"delete_dns_record",
		{ domainId: "d1", recordId: "r1" },
		{ method: "DELETE", path: "/domains/d1/records/r1" },
	],
	["get_registry_settings", {}, { method: "GET", path: "/registry/settings" }],
	["list_registry_tokens", {}, { method: "GET", path: "/registry/tokens" }],
	[
		"list_registry_repositories",
		{},
		{ method: "GET", path: "/registry/repositories?perPage=100" },
	],
	[
		"list_registry_repositories",
		{ page: 2, search: "team" },
		{ method: "GET", path: "/registry/repositories?perPage=100&page=2&q=team" },
	],
	[
		"list_registry_tags",
		{ repository: "team/app" },
		{ method: "GET", path: "/registry/repositories/team/app/tags" },
	],
	[
		"list_registry_tags",
		{ repository: "team/a?b" },
		{ method: "GET", path: "/registry/repositories/team/a%3Fb/tags" },
	],
	[
		"list_remote_hosts",
		{},
		{ method: "GET", path: "/remote-hosts?perPage=100" },
	],
	[
		"list_users",
		{ search: "ann" },
		{ method: "GET", path: "/users?perPage=100&q=ann" },
	],
	["list_git_providers", {}, { method: "GET", path: "/git-providers" }],
];

describe("MCP version, monitoring, system, DNS and admin tools", () => {
	test("are registered once each", async () => {
		const names = await harness().listTools();
		expect(new Set(names).size).toBe(names.length);
		for (const [name] of cases) {
			expect(names).toContain(name);
		}
		expect(names).toContain("preview_docker_cleanup");
	});

	for (const [name, args, expected] of cases) {
		test(`${name} ${JSON.stringify(args)} calls ${expected.method} ${expected.path}`, async () => {
			const { call, calls } = harness();
			const result = await call(name, args);
			expect(result.isError).toBeFalsy();
			expect(calls).toEqual([expected]);
		});
	}

	test("no tool creates or changes credential-holding config, users or registry tokens", async () => {
		const names = await harness().listTools();
		for (const name of names) {
			expect(name).not.toMatch(
				/(create|update|delete)_(dns_connection|git_provider|object_store|remote_host|user|registry_token)/,
			);
		}
	});

	test("run_docker_cleanup won't prune volumes", async () => {
		const { call, calls } = harness();
		const result = await call("run_docker_cleanup", {
			action: "pruneVolumes",
		});
		expect(result.isError).toBe(true);
		expect(calls).toEqual([]);
	});

	test("preview_docker_cleanup sums up each category instead of listing it", async () => {
		const { call } = harness(() =>
			Response.json({
				buildCache: { items: [], totalCount: 0 },
				containers: {
					items: [{ id: "c1", label: "old", sizeBytes: 10 }],
					totalCount: 3,
				},
				images: {
					items: [
						{ id: "i1", label: "a", sizeBytes: 100 },
						{ id: "i2", label: "b" },
					],
					totalCount: 5,
				},
				networks: { items: [], totalCount: 2 },
				orphanStackNetworks: [],
				volumes: { items: [], totalCount: 1 },
			}),
		);
		const result = await call("preview_docker_cleanup");
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
			buildCache: { removable: 0, removableBytes: 0, total: 0 },
			containers: { removable: 1, removableBytes: 10, total: 3 },
			images: { removable: 2, removableBytes: 100, total: 5 },
			networks: { removable: 0, removableBytes: 0, total: 2 },
			orphanStackNetworks: [],
			volumes: { removable: 0, removableBytes: 0, total: 1 },
		});
		const refused = harness(() =>
			Response.json({ error: "Forbidden" }, { status: 403 }),
		);
		expect((await refused.call("preview_docker_cleanup")).isError).toBe(true);
	});

	test("system logs reach the agent with their inline secrets masked", async () => {
		const { call } = harness(() =>
			Response.json([
				{
					message: "Deploy failed: dial postgres://app:hunter2@db/app",
					metadata: '["--password s3cret"]',
				},
			]),
		);
		const text = (await call("list_system_logs")).content[0]?.text ?? "";
		expect(text).not.toMatch(/hunter2|s3cret/);
	});
});

describe("get_cron_job and update_cron_job", () => {
	const stored = {
		command: null,
		envVars: {},
		files: [{ content: "DB_PASSWORD=hunter2\nTZ=UTC", path: "/app/.env" }],
		id: "c1",
		source: 'const API_TOKEN = "t0k3n";\nconsole.log("hi");',
	};

	test("get_cron_job hides what its source and files assign to secret-looking names", async () => {
		const { call } = harness(() => Response.json(stored));
		const text = (await call("get_cron_job", { cronJobId: "c1" })).content[0]
			?.text;
		expect(text).not.toMatch(/hunter2|t0k3n/);
		const job = JSON.parse(text ?? "") as typeof stored;
		expect(job.files[0]?.content).toBe(`DB_PASSWORD=${REDACTED}\nTZ=UTC`);
		expect(job.source).toContain('console.log("hi");');
	});

	test("update_cron_job keeps the stored source and files sent back as read", async () => {
		const { call, calls } = harness(({ method }) =>
			Response.json(method === "GET" ? stored : { id: "c1" }),
		);
		const result = await call("update_cron_job", {
			cronJobId: "c1",
			files: [
				{ content: `DB_PASSWORD=${REDACTED}\nTZ=UTC`, path: "/app/.env" },
				{ content: "hello", path: "/app/new.txt" },
			],
			source: `const API_TOKEN = ${REDACTED}\nconsole.log("bye");`,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("source still contains");

		const kept = await call("update_cron_job", {
			cronJobId: "c1",
			files: [
				{ content: `DB_PASSWORD=${REDACTED}\nTZ=UTC`, path: "/app/.env" },
				{ content: "hello", path: "/app/new.txt" },
			],
			source: `const API_TOKEN = ${REDACTED}\nconsole.log("hi");`,
		});
		expect(kept.isError).toBeFalsy();
		expect(calls.at(-1)).toEqual({
			body: {
				files: [stored.files[0], { content: "hello", path: "/app/new.txt" }],
				source: stored.source,
			},
			method: "PATCH",
			path: "/cron-jobs/c1",
		});
	});

	test("update_cron_job sends a plain source without reading the job first", async () => {
		const { call, calls } = harness();
		await call("update_cron_job", { cronJobId: "c1", source: "echo hi" });
		expect(calls).toEqual([
			{ body: { source: "echo hi" }, method: "PATCH", path: "/cron-jobs/c1" },
		]);
	});
});
