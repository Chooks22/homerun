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
		calls,
		call: (name: string, args: Record<string, unknown> = {}) =>
			rpc("tools/call", { arguments: args, name }) as Promise<ToolResult>,
		listTools: async () =>
			((await rpc("tools/list")) as { tools: { name: string }[] }).tools.map(
				(tool) => tool.name,
			),
	};
}

describe("MCP tools", () => {
	test("every area's tools are registered once each", async () => {
		const names = await harness().listTools();
		expect(new Set(names).size).toBe(names.length);
		for (const name of [
			"list_cron_jobs",
			"get_cron_job_run",
			"list_stacks",
			"get_stack",
			"create_service",
			"list_templates",
			"list_environments",
			"set_release_channels",
			"promote_preview",
			"scan_service",
			"mount_volume",
			"list_backup_destinations",
			"update_error",
			"list_status_pages",
			"list_notifications",
			"delete_notification_channel",
		]) {
			expect(names).toContain(name);
		}
	});

	const cases: [string, Record<string, unknown>, Call][] = [
		[
			"get_service",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc" },
		],
		[
			"get_service_config",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/config" },
		],
		[
			"service_logs",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/logs" },
		],
		[
			"service_logs",
			{ serviceId: "svc", tail: 5 },
			{ method: "GET", path: "/services/svc/logs?tail=5" },
		],
		[
			"list_revisions",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/revisions" },
		],
		[
			"list_deployments",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/deployments" },
		],
		[
			"list_deployments",
			{ limit: 3, serviceId: "svc" },
			{ method: "GET", path: "/services/svc/deployments?limit=3" },
		],
		[
			"list_errors",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/errors?perPage=50" },
		],
		[
			"list_errors",
			{ search: "boom", serviceId: "svc", status: "all" },
			{
				method: "GET",
				path: "/services/svc/errors?perPage=50&q=boom&status=all",
			},
		],
		[
			"get_error",
			{ issueId: "i1", serviceId: "svc" },
			{ method: "GET", path: "/services/svc/errors/i1" },
		],
		[
			"get_error",
			{ eventId: "ev", issueId: "i1", serviceId: "svc" },
			{ method: "GET", path: "/services/svc/errors/i1?event=ev" },
		],
		[
			"list_dependencies",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/dependencies" },
		],
		[
			"set_dependencies",
			{ dependsOn: ["db"], serviceId: "svc" },
			{
				body: { dependsOn: ["db"] },
				method: "PUT",
				path: "/services/svc/dependencies",
			},
		],
		["system_stats", {}, { method: "GET", path: "/system-stats" }],
		["instance_status", {}, { method: "GET", path: "/instance/update" }],
		["list_volumes", {}, { method: "GET", path: "/volumes?perPage=100" }],
		["list_backups", {}, { method: "GET", path: "/backups?perPage=50" }],
		[
			"list_backups",
			{ outcome: "failed", volumeId: "v1" },
			{ method: "GET", path: "/backups?perPage=50&outcome=failed&volume=v1" },
		],
		["get_job", { jobId: "j1" }, { method: "GET", path: "/jobs/j1" }],
		["list_jobs", {}, { method: "GET", path: "/jobs?perPage=50" }],
		[
			"list_jobs",
			{ status: "failed" },
			{ method: "GET", path: "/jobs?perPage=50&status=failed" },
		],
		[
			"run_backup",
			{ volumeId: "v1" },
			{ method: "POST", path: "/volumes/v1/backup" },
		],
		[
			"update_service",
			{ changes: { containerPort: 80 }, serviceId: "svc" },
			{ body: { containerPort: 80 }, method: "PATCH", path: "/services/svc" },
		],
		[
			"deploy_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/deploy" },
		],
		[
			"deploy_service",
			{ serviceId: "svc", tag: "1.2" },
			{ body: { tag: "1.2" }, method: "POST", path: "/services/svc/deploy" },
		],
		[
			"restart_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/restart" },
		],
		[
			"start_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/start" },
		],
		[
			"stop_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/stop" },
		],
		[
			"rollback_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/revisions/previous/deploy" },
		],
		[
			"rollback_service",
			{ restoreConfig: true, revisionId: "r1", serviceId: "svc" },
			{
				method: "POST",
				path: "/services/svc/revisions/r1/deploy?restoreConfig=true",
			},
		],
		["list_redirects", {}, { method: "GET", path: "/redirects?perPage=100" }],
		[
			"create_redirect",
			{ destination: "https://b.example", source: "a.example" },
			{
				body: { destination: "https://b.example", source: "a.example" },
				method: "POST",
				path: "/redirects",
			},
		],
		[
			"update_redirect",
			{ enabled: false, redirectId: "rd1" },
			{ body: { enabled: false }, method: "PATCH", path: "/redirects/rd1" },
		],
		[
			"delete_redirect",
			{ redirectId: "rd1" },
			{ method: "DELETE", path: "/redirects/rd1" },
		],
		["list_object_stores", {}, { method: "GET", path: "/object-stores" }],
		[
			"list_buckets",
			{ storeId: "st" },
			{ method: "GET", path: "/object-stores/st/buckets" },
		],
		[
			"get_bucket",
			{ bucket: "b", storeId: "st" },
			{ method: "GET", path: "/object-stores/st/buckets/b" },
		],
		[
			"create_bucket",
			{ name: "media", storeId: "st" },
			{
				body: { name: "media" },
				method: "POST",
				path: "/object-stores/st/buckets",
			},
		],
		[
			"update_bucket",
			{ bucket: "b", public: true, storeId: "st" },
			{
				body: { public: true },
				method: "PATCH",
				path: "/object-stores/st/buckets/b",
			},
		],
		[
			"delete_bucket",
			{ bucket: "b", storeId: "st" },
			{ method: "DELETE", path: "/object-stores/st/buckets/b" },
		],
		[
			"get_cron_job",
			{ cronJobId: "c/1" },
			{ method: "GET", path: "/cron-jobs/c%2F1" },
		],
		[
			"create_cron_job",
			{ kind: "image", image: "alpine", name: "Ping", schedule: "*/5 * * * *" },
			{
				body: {
					dockerSocket: false,
					enabled: false,
					envVars: {},
					files: [],
					image: "alpine",
					kind: "image",
					mounts: [],
					name: "Ping",
					schedule: "*/5 * * * *",
					secretEnvKeys: [],
				},
				method: "POST",
				path: "/cron-jobs",
			},
		],
		[
			"update_cron_job",
			{ cronJobId: "c1", enabled: true },
			{ body: { enabled: true }, method: "PATCH", path: "/cron-jobs/c1" },
		],
		[
			"delete_cron_job",
			{ cronJobId: "c1" },
			{ method: "DELETE", path: "/cron-jobs/c1" },
		],
		[
			"run_cron_job",
			{ cronJobId: "c1" },
			{ method: "POST", path: "/cron-jobs/c1/run" },
		],
		[
			"list_cron_job_runs",
			{ cronJobId: "c1", limit: 5 },
			{ method: "GET", path: "/cron-jobs/c1/runs?limit=5" },
		],
		[
			"get_cron_job_run",
			{ cronJobId: "c1", runId: "r1" },
			{ method: "GET", path: "/cron-jobs/c1/runs/r1" },
		],
		["list_stacks", {}, { method: "GET", path: "/stacks?perPage=100" }],
		["get_stack", { stackId: "s1" }, { method: "GET", path: "/stacks/s1" }],
		[
			"create_stack",
			{ name: "Media", slug: "media" },
			{
				body: { name: "Media", slug: "media" },
				method: "POST",
				path: "/stacks",
			},
		],
		[
			"update_stack",
			{ name: "Films", stackId: "s1" },
			{ body: { name: "Films" }, method: "PATCH", path: "/stacks/s1" },
		],
		[
			"get_template",
			{ templateId: "t1" },
			{ method: "GET", path: "/templates/t1" },
		],
		[
			"create_service",
			{ settings: { name: "Web" }, templateId: "t1" },
			{
				body: { name: "Web", templateId: "t1" },
				method: "POST",
				path: "/services",
			},
		],
		[
			"create_service",
			{ settings: { image: "nginx", name: "Web", slug: "web" } },
			{
				body: { image: "nginx", name: "Web", slug: "web" },
				method: "POST",
				path: "/services",
			},
		],
		[
			"create_environment",
			{ name: "staging", ref: "develop", serviceId: "svc" },
			{
				body: {
					deploy: false,
					envOverrides: {},
					name: "staging",
					ref: "develop",
					serviceId: "svc",
				},
				method: "POST",
				path: "/service-environments",
			},
		],
		[
			"update_environment",
			{ environmentId: "e1", ref: "main" },
			{
				body: { envOverrides: {}, ref: "main" },
				method: "PATCH",
				path: "/service-environments/e1",
			},
		],
		[
			"get_release_channels",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/channels" },
		],
		[
			"set_release_channels",
			{ enabled: true, serviceId: "svc", tagPattern: "v*" },
			{
				body: { enabled: true, tagPattern: "v*" },
				method: "PATCH",
				path: "/services/svc/channels",
			},
		],
		[
			"list_previews",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/previews" },
		],
		[
			"get_preview",
			{ prNumber: 12, serviceId: "svc" },
			{ method: "GET", path: "/services/svc/previews/12" },
		],
		[
			"promote_preview",
			{ prNumber: 12, serviceId: "svc" },
			{ body: {}, method: "POST", path: "/services/svc/previews/12/promote" },
		],
		[
			"promote_preview",
			{ commit: "abc1234", prNumber: 12, serviceId: "svc" },
			{
				body: { commit: "abc1234" },
				method: "POST",
				path: "/services/svc/previews/12/promote",
			},
		],
		[
			"list_scans",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/scans?perPage=50" },
		],
		[
			"get_scan",
			{ serviceId: "svc" },
			{ method: "GET", path: "/services/svc/scans/latest" },
		],
		[
			"get_scan",
			{ scanId: "sc1", serviceId: "svc" },
			{ method: "GET", path: "/services/svc/scans/sc1" },
		],
		[
			"scan_service",
			{ serviceId: "svc" },
			{ method: "POST", path: "/services/svc/scans" },
		],
		[
			"update_error",
			{ issueId: "i1", serviceId: "svc", status: "resolved" },
			{
				body: { status: "resolved" },
				method: "PATCH",
				path: "/services/svc/errors/i1",
			},
		],
		[
			"create_volume",
			{ kind: "volume", name: "Data", source: "data" },
			{
				body: { kind: "volume", name: "Data", source: "data" },
				method: "POST",
				path: "/volumes",
			},
		],
		[
			"update_volume",
			{ backupEnabled: true, volumeId: "v1" },
			{ body: { backupEnabled: true }, method: "PATCH", path: "/volumes/v1" },
		],
		[
			"mount_volume",
			{ containerPath: "/data", serviceId: "svc", volumeId: "v1" },
			{
				body: {
					containerPath: "/data",
					readOnly: false,
					serviceId: "svc",
					volumeId: "v1",
				},
				method: "POST",
				path: "/volume-mounts",
			},
		],
		[
			"update_volume_mount",
			{ mountId: "m1", readOnly: true },
			{ body: { readOnly: true }, method: "PATCH", path: "/volume-mounts/m1" },
		],
		[
			"unmount_volume",
			{ mountId: "m1" },
			{ method: "DELETE", path: "/volume-mounts/m1" },
		],
		[
			"list_backup_destinations",
			{},
			{ method: "GET", path: "/backup-destinations?perPage=100" },
		],
		["list_status_pages", {}, { method: "GET", path: "/status-pages" }],
		[
			"create_status_page",
			{ name: "Status", scope: "global", slug: "status" },
			{
				body: {
					isPublic: false,
					name: "Status",
					scope: "global",
					services: [],
					slug: "status",
				},
				method: "POST",
				path: "/status-pages",
			},
		],
		[
			"update_status_page",
			{ isPublic: true, statusPageId: "p1" },
			{ body: { isPublic: true }, method: "PATCH", path: "/status-pages/p1" },
		],
		[
			"delete_status_page",
			{ statusPageId: "p1" },
			{ method: "DELETE", path: "/status-pages/p1" },
		],
		["list_notifications", {}, { method: "GET", path: "/notifications?" }],
		[
			"list_notifications",
			{ limit: 10, unread: true },
			{ method: "GET", path: "/notifications?limit=10&unread=true" },
		],
		[
			"mark_notifications_read",
			{},
			{ body: {}, method: "POST", path: "/notifications/read" },
		],
		[
			"mark_notifications_read",
			{ id: "n1" },
			{ body: { id: "n1" }, method: "POST", path: "/notifications/read" },
		],
		[
			"list_notification_channels",
			{},
			{ method: "GET", path: "/notification-channels" },
		],
		[
			"create_notification_channel",
			{
				kind: "discord",
				name: "Ops",
				target: "https://discord.com/api/webhooks/1/x",
			},
			{
				body: {
					kind: "discord",
					name: "Ops",
					target: "https://discord.com/api/webhooks/1/x",
				},
				method: "POST",
				path: "/notification-channels",
			},
		],
		[
			"update_notification_channel",
			{ channelId: "ch1", enabled: false },
			{
				body: { enabled: false },
				method: "PATCH",
				path: "/notification-channels/ch1",
			},
		],
		[
			"delete_notification_channel",
			{ channelId: "ch1" },
			{ method: "DELETE", path: "/notification-channels/ch1" },
		],
	];

	for (const [name, args, expected] of cases) {
		test(`${name} ${JSON.stringify(args)} calls ${expected.method} ${expected.path}`, async () => {
			const { call, calls } = harness();
			const result = await call(name, args);
			expect(result.isError).toBeFalsy();
			expect(calls).toEqual([expected]);
		});
	}

	test("a refused API call comes back as a tool error with its status", async () => {
		const { call } = harness(() =>
			Response.json({ error: "Not found" }, { status: 404 }),
		);
		const result = await call("get_cron_job", { cronJobId: "gone" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe('HTTP 404: {"error":"Not found"}');
	});

	test("list tools summarise each row, and pass a refusal through", async () => {
		const { call } = harness(({ path }) =>
			Response.json(
				path.startsWith("/cron-jobs")
					? [{ envVars: { A: "b" }, id: "c1", kind: "image", name: "Ping" }]
					: [{ envVars: {}, id: "t1", name: "Redis", ownerId: null }],
			),
		);
		const jobs = await call("list_cron_jobs", { search: "pi" });
		expect(JSON.parse(jobs.content[0]?.text ?? "")).toEqual([
			{ id: "c1", kind: "image", name: "Ping" },
		]);
		const templates = await call("list_templates", { search: "red" });
		expect(JSON.parse(templates.content[0]?.text ?? "")).toEqual([
			{ builtin: true, id: "t1", name: "Redis" },
		]);

		const refused = harness(() =>
			Response.json({ error: "Forbidden" }, { status: 403 }),
		);
		for (const name of ["list_cron_jobs", "list_templates"]) {
			expect((await refused.call(name)).isError).toBe(true);
		}
	});

	test("list_environments and list_volume_mounts filter by the ids given", async () => {
		const { call, calls } = harness(({ path }) =>
			Response.json(
				path === "/service-environments"
					? [
							{ id: "e1", serviceId: "a" },
							{ id: "e2", serviceId: "b" },
						]
					: [
							{ id: "m1", serviceId: "a", volumeId: "v1" },
							{ id: "m2", serviceId: "a", volumeId: "v2" },
							{ id: "m3", serviceId: "b", volumeId: "v1" },
						],
			),
		);
		const environments = await call("list_environments", { serviceId: "b" });
		expect(JSON.parse(environments.content[0]?.text ?? "")).toEqual([
			{ id: "e2", serviceId: "b" },
		]);
		const all = await call("list_environments");
		expect(JSON.parse(all.content[0]?.text ?? "")).toHaveLength(2);
		const byService = await call("list_volume_mounts", { serviceId: "a" });
		expect(
			JSON.parse(byService.content[0]?.text ?? "").map(
				(row: { id: string }) => row.id,
			),
		).toEqual(["m1", "m2"]);
		const byBoth = await call("list_volume_mounts", {
			serviceId: "a",
			volumeId: "v1",
		});
		expect(
			JSON.parse(byBoth.content[0]?.text ?? "").map(
				(row: { id: string }) => row.id,
			),
		).toEqual(["m1"]);
		await call("list_volume_mounts");
		expect(calls.map((c) => c.path)).toEqual([
			"/service-environments",
			"/service-environments",
			"/volume-mounts",
			"/volume-mounts",
			"/volume-mounts",
		]);
	});

	test("a run's output and a job's command reach the agent with their passwords masked", async () => {
		const { call } = harness(() =>
			Response.json({
				command: "pg_dump postgres://app:hunter2@db/app",
				output:
					"connecting to postgres://app:hunter2@db/app\n--password s3cret",
			}),
		);
		const result = await call("get_cron_job_run", {
			cronJobId: "c1",
			runId: "r1",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).not.toMatch(/hunter2|s3cret/);
		expect(text).toContain(`postgres://app:${REDACTED}@db/app`);
	});
});

describe("list_services and update_service", () => {
	test("list_services summarises each service", async () => {
		const { call, calls } = harness(() =>
			Response.json([
				{ envVars: { A: "b" }, id: "s1", name: "Web", previewParentId: null },
			]),
		);
		const result = await call("list_services", { search: "we" });
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
			{ id: "s1", name: "Web" },
		]);
		expect(calls[0]?.path).toBe("/services?perPage=100&q=we");
		const refused = harness(() =>
			Response.json({ error: "Forbidden" }, { status: 403 }),
		);
		expect((await refused.call("list_services")).isError).toBe(true);
	});

	test("get_service shows an uploaded icon as a label, update_service doesn't write the label back", async () => {
		const { call, calls } = harness(({ method }) =>
			Response.json(
				method === "GET"
					? { icon: "data:image/png;base64,iVBORw0KGgo=", id: "svc" }
					: {},
			),
		);
		const read = await call("get_service", { serviceId: "svc" });
		expect(JSON.parse(read.content[0]?.text ?? "").icon).toBe("uploaded");
		await call("update_service", {
			changes: { icon: "uploaded", name: "Web" },
			serviceId: "svc",
		});
		expect(calls.at(-1)).toEqual({
			body: { name: "Web" },
			method: "PATCH",
			path: "/services/svc",
		});
	});

	test("update_service merges env and restores redacted arguments", async () => {
		const stored = {
			command: ["valkey-server", "--requirepass", "s3cret"],
			entrypoint: null,
			envVars: { DB_PASSWORD: "hunter2", TZ: "UTC" },
		};
		const { call, calls } = harness(({ method }) =>
			Response.json(method === "GET" ? stored : {}),
		);
		await call("update_service", {
			changes: {
				command: ["valkey-server", "--requirepass", REDACTED],
				envVars: { DB_PASSWORD: REDACTED, TZ: "Europe/Paris" },
			},
			serviceId: "svc",
		});
		expect(calls[1]).toEqual({
			body: {
				command: stored.command,
				envVars: { DB_PASSWORD: "hunter2", TZ: "Europe/Paris" },
			},
			method: "PATCH",
			path: "/services/svc",
		});
		const refused = await harness(() => Response.json(stored)).call(
			"update_service",
			{ changes: { envVars: { NEW_TOKEN: REDACTED } }, serviceId: "svc" },
		);
		expect(refused.isError).toBe(true);
		const missing = await harness(() =>
			Response.json({ error: "Not found" }, { status: 404 }),
		).call("update_service", {
			changes: { envVars: { A: "1" } },
			serviceId: "gone",
		});
		expect(missing.isError).toBe(true);
	});
});

describe("update_cron_job", () => {
	const stored = {
		command: "pg_dump postgres://app:hunter2@db/app",
		envVars: { API_TOKEN: "t0k3n", TZ: "UTC" },
		id: "c1",
	};

	test("merges env changes and keeps what came back redacted", async () => {
		const { call, calls } = harness(({ method }) =>
			Response.json(method === "GET" ? stored : { id: "c1" }),
		);
		const result = await call("update_cron_job", {
			command: `pg_dump postgres://app:${REDACTED}@db/app`,
			cronJobId: "c1",
			envVars: { API_TOKEN: REDACTED, NEW: "1", TZ: null },
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([
			{ method: "GET", path: "/cron-jobs/c1" },
			{
				body: {
					command: stored.command,
					envVars: { API_TOKEN: "t0k3n", NEW: "1" },
				},
				method: "PATCH",
				path: "/cron-jobs/c1",
			},
		]);
	});

	test("refuses a placeholder that matches nothing stored instead of writing it", async () => {
		const { call, calls } = harness(() => Response.json(stored));
		const result = await call("update_cron_job", {
			command: `curl -u admin:${REDACTED} https://example.com`,
			cronJobId: "c1",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("command still contains");
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	test("a var marked secret is redacted on read and kept when echoed back", async () => {
		const marked = {
			...stored,
			envVars: { TMDB: "abc123", TZ: "UTC" },
			secretEnvKeys: ["TMDB"],
		};
		const { call, calls } = harness(({ method }) =>
			Response.json(method === "GET" ? marked : { id: "c1" }),
		);
		const read = await call("get_cron_job", { cronJobId: "c1" });
		expect(JSON.parse(read.content[0]?.text ?? "").envVars).toEqual({
			TMDB: REDACTED,
			TZ: "UTC",
		});
		await call("update_cron_job", {
			cronJobId: "c1",
			envVars: { TMDB: REDACTED, TZ: "Europe/Paris" },
		});
		expect(calls.at(-1)).toEqual({
			body: { envVars: { TMDB: "abc123", TZ: "Europe/Paris" } },
			method: "PATCH",
			path: "/cron-jobs/c1",
		});
	});

	test("passes the cron job's own refusal through", async () => {
		const { call, calls } = harness(() =>
			Response.json({ error: "Not found" }, { status: 404 }),
		);
		const result = await call("update_cron_job", {
			cronJobId: "gone",
			envVars: { A: "1" },
		});
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(1);
	});
});
