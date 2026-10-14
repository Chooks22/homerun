import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	maskFileText,
	mergeEnvChanges,
	REDACTED,
	restoreFiles,
	restoreMaskedText,
} from "#lib/server/mcp-redact.js";
import {
	type ApiCall,
	asResult,
	change,
	errorResult,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	cronJobApiBody,
	updateCronJobApiBody,
} from "#lib/server/validation/api-resources.js";

const cronJobId = z.string().describe("The cron job's id, from list_cron_jobs");

/** A path under a cron job, with its id escaped. */
function cronJobPath(id: string, suffix = ""): string {
	return `/cron-jobs/${encodeURIComponent(id)}${suffix}`;
}

/**
 * Patches a cron job for `update_cron_job`. Env changes are merged into the
 * stored vars (`null` deletes one) instead of replacing them, and a command,
 * script source, file content or env value sent back exactly as the agent
 * read it, redacted parts included (a var the owner marked secret too),
 * keeps its stored value; a placeholder that matches nothing stored is
 * refused.
 */
async function updateCronJob(
	api: ApiCall,
	id: string,
	changes: Record<string, unknown>,
): Promise<CallToolResult> {
	const patch = { ...changes };
	const masked = [patch.command, patch.source, JSON.stringify(patch.files)];
	if (
		patch.envVars === undefined &&
		!masked.some((text) => typeof text === "string" && text.includes(REDACTED))
	) {
		return asResult(await api("PATCH", cronJobPath(id), patch));
	}
	const current = await api("GET", cronJobPath(id));
	if (!current.ok) {
		return asResult(current);
	}
	const stored = (await current.json()) as {
		command: string | null;
		envVars: Record<string, string> | null;
		files: { content: string; path: string }[] | null;
		secretEnvKeys?: string[];
		source: string | null;
	};
	try {
		if (patch.envVars && typeof patch.envVars === "object") {
			patch.envVars = mergeEnvChanges(
				patch.envVars as Record<string, unknown>,
				stored.envVars ?? {},
				new Set(stored.secretEnvKeys ?? []),
			);
		}
		if (typeof patch.command === "string") {
			patch.command = restoreMaskedText(
				"command",
				patch.command,
				stored.command,
			);
		}
		if (typeof patch.source === "string") {
			patch.source = restoreMaskedText(
				"source",
				patch.source,
				stored.source,
				maskFileText,
			);
		}
		if (Array.isArray(patch.files)) {
			patch.files = restoreFiles(patch.files, stored.files);
		}
	} catch (err) {
		return errorResult(err);
	}
	return asResult(await api("PATCH", cronJobPath(id), patch));
}

/** Registers the tools over cron jobs' config: listing, reading, creating, changing and deleting them. */
function registerCronJobConfigTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_cron_jobs",
		{
			annotations: read,
			description:
				"List cron jobs (scheduled containers, scripts and host commands) with their id, name, kind, schedule, whether the schedule is on, image or runtime, and last run.",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe("Only cron jobs whose name matches this term"),
			}),
		},
		async ({ search }) => {
			const query = new URLSearchParams({ perPage: "100" });
			if (search) {
				query.set("q", search);
			}
			const response = await api("GET", `/cron-jobs?${query}`);
			if (!response.ok) {
				return await asResult(response);
			}
			const rows = (await response.json()) as Record<string, unknown>[];
			const summary = rows.map((row) => ({
				description: row.description,
				enabled: row.enabled,
				id: row.id,
				image: row.image,
				kind: row.kind,
				lastRunAt: row.lastRunAt,
				name: row.name,
				remoteHostId: row.remoteHostId,
				runtime: row.runtime,
				schedule: row.schedule,
				tag: row.tag,
			}));
			return { content: [{ text: JSON.stringify(summary), type: "text" }] };
		},
	);

	server.registerTool(
		"get_cron_job",
		{
			annotations: read,
			description:
				"A cron job's full config: kind, schedule, enabled, image and tag or script runtime and source, command, env vars, files, volume mounts, Docker socket, user, timeout and remote host. Env vars marked secret (secretEnvKeys), secret-looking or credential-looking env vars, URL passwords and password arguments are redacted, and so are the values a script's source or a file assigns to a secret-looking name.",
			inputSchema: z.object({ cronJobId }),
		},
		async ({ cronJobId: id }) => asResult(await api("GET", cronJobPath(id))),
	);

	server.registerTool(
		"create_cron_job",
		{
			annotations: change,
			description:
				"Create a cron job: an image (a container), a script (source code on a runtime image) or exec (a host command, needs write access to System). Its schedule is off (enabled false) unless asked; run_cron_job runs it either way.",
			inputSchema: cronJobApiBody,
		},
		async (input) => asResult(await api("POST", "/cron-jobs", input)),
	);

	server.registerTool(
		"update_cron_job",
		{
			annotations: change,
			description: `Change a cron job's fields, keeping the ones left out. enabled turns its schedule on or off. Applies from its next run. A command, source or file content sent back as you read it, "${REDACTED}" included, keeps its stored value.`,
			inputSchema: updateCronJobApiBody.extend({
				cronJobId,
				envVars: z
					.record(z.string(), z.string().nullable())
					.optional()
					.describe(
						`Merged into the stored vars: send only the ones to change, null deletes one. A value left as you read it, "${REDACTED}" included, keeps its stored value.`,
					),
			}),
		},
		({ cronJobId: id, ...changes }) => updateCronJob(api, id, changes),
	);

	server.registerTool(
		"delete_cron_job",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description: "Delete a cron job and its run history.",
			inputSchema: z.object({ cronJobId }),
		},
		async ({ cronJobId: id }) => asResult(await api("DELETE", cronJobPath(id))),
	);
}

/** Registers the tools that run a cron job now and read its runs, each one's log included. */
function registerCronJobRunTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"run_cron_job",
		{
			annotations: change,
			description:
				"Queue a run of a cron job now, whether or not its schedule is on, and return its queue job id. Follow it with get_job, then read the run with list_cron_job_runs and get_cron_job_run.",
			inputSchema: z.object({ cronJobId }),
		},
		async ({ cronJobId: id }) =>
			asResult(await api("POST", cronJobPath(id, "/run"))),
	);

	server.registerTool(
		"list_cron_job_runs",
		{
			annotations: read,
			description:
				"A cron job's latest runs, newest first: start and finish time, success (null while running), exit code, error and the length of its output. Read one run's output with get_cron_job_run.",
			inputSchema: z.object({
				cronJobId,
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("How many runs to return (default 20)"),
			}),
		},
		async ({ cronJobId: id, limit }) =>
			asResult(
				await api(
					"GET",
					cronJobPath(id, `/runs${limit ? `?limit=${limit}` : ""}`),
				),
			),
	);

	server.registerTool(
		"get_cron_job_run",
		{
			annotations: read,
			description:
				"One cron job run with its log: the output it printed (the newest 64k characters, still growing while it runs), exit code and error.",
			inputSchema: z.object({
				cronJobId,
				runId: z.string().describe("The run's id, from list_cron_job_runs"),
			}),
		},
		async ({ cronJobId: id, runId }) =>
			asResult(
				await api("GET", cronJobPath(id, `/runs/${encodeURIComponent(runId)}`)),
			),
	);
}

/** Registers the cron job tools: the jobs' config, creating, changing, deleting and running them, and their runs with each one's log. */
export function registerCronJobTools(server: McpServer, api: ApiCall): void {
	registerCronJobConfigTools(server, api);
	registerCronJobRunTools(server, api);
}
