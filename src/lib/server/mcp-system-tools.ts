import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ApiCall, asResult, read } from "#lib/server/mcp-tool-kit.js";

const range = z
	.enum(["today", "week", "month", "year", "all"])
	.optional()
	.describe("The period to sum up (default week)");

const AGENT_CLEANUP_ACTIONS = [
	"pruneContainers",
	"pruneImages",
	"pruneNetworks",
	"pruneBuildCache",
	"pruneSystem",
	"pruneMirror",
	"reclaimStackNetworks",
] as const;

interface CleanupCategory {
	items: { sizeBytes?: number }[];
	totalCount: number;
}

/** A cleanup preview cut down to what each prune would reclaim, without listing every image and container. */
function cleanupSummary(preview: Record<string, unknown>) {
	const categories = [
		"buildCache",
		"containers",
		"images",
		"networks",
		"volumes",
	];
	return {
		...Object.fromEntries(
			categories.map((name) => {
				const category = preview[name] as CleanupCategory | undefined;
				const items = category?.items ?? [];
				return [
					name,
					{
						removable: items.length,
						removableBytes: items.reduce(
							(sum, item) => sum + (item.sizeBytes ?? 0),
							0,
						),
						total: category?.totalCount ?? 0,
					},
				];
			}),
		),
		orphanStackNetworks: preview.orphanStackNetworks,
	};
}

/** Registers the monitoring tools: the instance's and a service's traffic, availability and resources, with a service's uptime probes. */
function registerMonitoringTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"get_monitoring",
		{
			annotations: read,
			description:
				"The instance's monitoring over a period: requests, 4xx and 5xx responses and response time (from Traefik), uptime probe availability, host CPU and memory, the previous period's totals to compare, and each service's share, busiest first.",
			inputSchema: z.object({ range }),
		},
		async ({ range: period }) =>
			asResult(await api("GET", `/monitoring?range=${period ?? "week"}`)),
	);

	server.registerTool(
		"get_service_monitoring",
		{
			annotations: read,
			description:
				"A service's monitoring over a period (traffic, availability, CPU and memory, and the previous period's) with the latest 30 beats of its internal and external uptime probes: each one's time, ok, latency and what failed.",
			inputSchema: z.object({
				range,
				serviceId: z.string().describe("The service's id, from list_services"),
			}),
		},
		async ({ range: period, serviceId }) =>
			asResult(
				await api(
					"GET",
					`/services/${encodeURIComponent(serviceId)}/monitoring?range=${period ?? "week"}`,
				),
			),
	);
}

/** Registers the tools over Homerun's own logs and containers, and Docker cleanup. */
function registerHostTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_system_logs",
		{
			annotations: read,
			description:
				"Homerun's own warnings and errors, newest first: level, scope, message and the service each one is about. Needs read access to System.",
			inputSchema: z.object({
				limit: z
					.number()
					.int()
					.min(1)
					.max(500)
					.optional()
					.describe("How many entries (default 100)"),
			}),
		},
		async ({ limit }) =>
			asResult(await api("GET", `/system/logs?limit=${limit ?? 100}`)),
	);

	server.registerTool(
		"list_system_containers",
		{
			annotations: read,
			description:
				"The instance's own containers (the app, the worker, Traefik, Postgres and the rest) with their state. Needs read access to System.",
		},
		async () => asResult(await api("GET", "/system/containers")),
	);

	server.registerTool(
		"system_container_logs",
		{
			annotations: read,
			description:
				"The latest lines one of the instance's own containers logged, Traefik's included. Needs read access to System.",
			inputSchema: z.object({
				containerId: z
					.string()
					.describe("The container's id, from list_system_containers"),
				tail: z
					.number()
					.int()
					.min(1)
					.max(10_000)
					.optional()
					.describe("How many of the latest lines (default 200)"),
			}),
		},
		async ({ containerId, tail }) =>
			asResult(
				await api(
					"GET",
					`/system/containers/${encodeURIComponent(containerId)}/logs?tail=${tail ?? 200}`,
				),
			),
	);

	server.registerTool(
		"preview_docker_cleanup",
		{
			annotations: read,
			description:
				"What each Docker prune would reclaim on this host: per category (stopped containers, unused images, networks, build cache, volumes) how many items exist, how many would go and their size, plus the networks of deleted stacks. Needs read access to System.",
		},
		async () => {
			const response = await api("GET", "/system/docker-cleanup");
			if (!response.ok) {
				return await asResult(response);
			}
			const preview = (await response.json()) as Record<string, unknown>;
			return {
				content: [
					{ text: JSON.stringify(cleanupSummary(preview)), type: "text" },
				],
			};
		},
	);

	server.registerTool(
		"run_docker_cleanup",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description:
				"Queue a Docker prune on this host and return its job id, follow it with get_job. It waits for running jobs and holds deploys back while it runs. Pruning volumes isn't offered: do that from the dashboard. Needs write access to System.",
			inputSchema: z.object({
				action: z
					.enum(AGENT_CLEANUP_ACTIONS)
					.describe(
						"pruneContainers (stopped containers), pruneImages (dangling images, every unused one with all), pruneNetworks, pruneBuildCache, pruneSystem (all four), pruneMirror (the image mirror's unused images) or reclaimStackNetworks (networks of deleted stacks)",
					),
				all: z
					.boolean()
					.optional()
					.describe(
						"pruneImages only: every unused image, tagged ones included",
					),
			}),
		},
		async ({ action, all }) =>
			asResult(await api("POST", "/system/docker-cleanup", { action, all })),
	);
}

/** Registers the monitoring, system log, instance container and Docker cleanup tools. */
export function registerSystemTools(server: McpServer, api: ApiCall): void {
	registerMonitoringTools(server, api);
	registerHostTools(server, api);
}
