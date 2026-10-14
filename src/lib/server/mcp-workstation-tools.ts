import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mergeEnvChanges, redactEnvValue } from "#lib/server/mcp-redact.js";
import {
	type ApiCall,
	asResult,
	change,
	errorResult,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	updateWorkstationApiBody,
	updateWorkstationPresetApiBody,
	workstationApiBody,
	workstationPresetApiBody,
} from "#lib/server/validation/infrastructure-api.js";

const workstationId = z
	.string()
	.describe("The workstation's id, from list_workstations");
const presetId = z
	.string()
	.describe("The preset's id, from list_workstation_presets");

const envChanges = z
	.record(z.string(), z.string().nullable())
	.optional()
	.describe(
		"Variables to change, merged into the stored ones: null deletes one, a value sent back exactly as read (redacted) keeps the stored one.",
	);

/** A path under a workstation, with its id escaped. */
function workstationPath(id: string): string {
	return `/workstations/${encodeURIComponent(id)}`;
}

/** A path under a workstation preset, with its id escaped. */
function presetPath(id: string): string {
	return `/workstation-presets/${encodeURIComponent(id)}`;
}

/** One workstation or preset with its `env` values masked like a service's. */
function redactEnv(item: unknown): unknown {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return item;
	}
	const env = (item as { env?: unknown }).env;
	if (!env || typeof env !== "object") {
		return item;
	}
	return {
		...item,
		env: Object.fromEntries(
			Object.entries(env).map(([name, value]) => [
				name,
				typeof value === "string" ? redactEnvValue(name, value) : value,
			]),
		),
	};
}

/**
 * The API's answer as a tool result, every workstation's or preset's `env`
 * masked by name first: the generic redaction only knows a service's
 * `envVars`.
 */
async function envRedacted(response: Response): Promise<CallToolResult> {
	const text = await response.text();
	if (!response.ok || !text) {
		return asResult(new Response(text, { status: response.status }));
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return asResult(new Response(text, { status: response.status }));
	}
	return asResult(
		Response.json(Array.isArray(body) ? body.map(redactEnv) : redactEnv(body)),
	);
}

/**
 * PATCHes a workstation or preset at `path`. Sent env changes are merged into
 * the stored variables instead of replacing them, since the REST PATCH
 * replaces the whole map, and a value sent back redacted keeps the stored
 * one.
 */
async function patchWithEnv(
	api: ApiCall,
	path: string,
	changes: Record<string, unknown>,
): Promise<CallToolResult> {
	const { env, ...rest } = changes;
	if (!env || typeof env !== "object") {
		return await envRedacted(await api("PATCH", path, rest));
	}
	const current = await api("GET", path);
	if (!current.ok) {
		return await asResult(current);
	}
	const stored = (await current.json()) as { env?: Record<string, string> };
	try {
		const merged = mergeEnvChanges(
			env as Record<string, unknown>,
			stored.env ?? {},
		);
		return await envRedacted(
			await api("PATCH", path, { ...rest, env: merged }),
		);
	} catch (err) {
		return errorResult(err);
	}
}

/** Registers the tools that list, read, create and change the caller's own dev workstations. */
function registerWorkstationCrudTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_workstations",
		{
			annotations: read,
			description:
				"List the caller's dev workstations (browser IDE containers) with their id, name, slug, domain, image, desired state, host, auto-stop, login wall and last error.",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe(
						"Only workstations whose name, slug, image or repo matches",
					),
				state: z
					.enum(["running", "stopped"])
					.optional()
					.describe("Only workstations last asked to run, or to stop"),
			}),
		},
		async ({ search, state }) => {
			const query = new URLSearchParams({ perPage: "100" });
			if (search) {
				query.set("q", search);
			}
			if (state) {
				query.set("state", state);
			}
			const response = await api("GET", `/workstations?${query}`);
			if (!response.ok) {
				return await asResult(response);
			}
			const rows = (await response.json()) as Record<string, unknown>[];
			const summary = rows.map((row) => ({
				authRequired: row.authRequired,
				autoStopMode: row.autoStopMode,
				desiredState: row.desiredState,
				domain: row.domain,
				id: row.id,
				image: row.image,
				lastError: row.lastError,
				name: row.name,
				remoteHostId: row.remoteHostId,
				slug: row.slug,
			}));
			return { content: [{ text: JSON.stringify(summary), type: "text" }] };
		},
	);

	server.registerTool(
		"get_workstation",
		{
			annotations: read,
			description:
				"A workstation's full config: image, port, home path, repository, editor extensions and settings, env (secret-looking values redacted), limits, auto-stop, login wall policy, host, domain, desired state and last error. Never its IDE password.",
			inputSchema: z.object({ workstationId }),
		},
		async ({ workstationId: id }) =>
			await envRedacted(await api("GET", workstationPath(id))),
	);

	server.registerTool(
		"create_workstation",
		{
			annotations: change,
			description:
				"Create a workstation for the caller and start it, unless desiredState is stopped. The domain and host can't change later; a hostname something else routes is refused.",
			inputSchema: workstationApiBody,
		},
		async (input) =>
			await envRedacted(await api("POST", "/workstations", input)),
	);

	server.registerTool(
		"update_workstation",
		{
			annotations: change,
			description:
				"Change a workstation's fields, keeping the ones left out. Settings apply on its next start; the login wall policy applies at once, and turning authRequired on or off restarts a running one. desiredState starts or stops it.",
			inputSchema: updateWorkstationApiBody.extend({
				env: envChanges,
				workstationId,
			}),
		},
		async ({ workstationId: id, ...changes }) =>
			await patchWithEnv(api, workstationPath(id), changes),
	);
}

/** Registers the tools that start, stop, recreate and delete one of the caller's workstations. */
function registerWorkstationLifecycleTools(
	server: McpServer,
	api: ApiCall,
): void {
	server.registerTool(
		"start_workstation",
		{
			annotations: change,
			description:
				"Start a stopped workstation, recreating its container from its current settings. The home volume survives.",
			inputSchema: z.object({ workstationId }),
		},
		async ({ workstationId: id }) =>
			await envRedacted(
				await api("PATCH", workstationPath(id), { desiredState: "running" }),
			),
	);

	server.registerTool(
		"recreate_workstation",
		{
			annotations: change,
			description:
				"Recreate a workstation's container from its current settings, like the dashboard's Recreate: pulls the image again and applies settings saved since its last start. The home volume survives; a stopped one starts.",
			inputSchema: z.object({ workstationId }),
		},
		async ({ workstationId: id }) =>
			await envRedacted(await api("POST", `${workstationPath(id)}/recreate`)),
	);

	server.registerTool(
		"stop_workstation",
		{
			annotations: change,
			description:
				"Stop a running workstation, keeping its container and home volume.",
			inputSchema: z.object({ workstationId }),
		},
		async ({ workstationId: id }) =>
			await envRedacted(
				await api("PATCH", workstationPath(id), { desiredState: "stopped" }),
			),
	);

	server.registerTool(
		"delete_workstation",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description:
				"Delete a workstation's container and record. Its home volume stays unless deleteVolume is true, which loses uncommitted work.",
			inputSchema: z.object({
				deleteVolume: z
					.boolean()
					.optional()
					.describe("Also delete the home volume and everything in it"),
				workstationId,
			}),
		},
		async ({ deleteVolume, workstationId: id }) =>
			await asResult(
				await api(
					"DELETE",
					`${workstationPath(id)}${deleteVolume ? "?volume=true" : ""}`,
				),
			),
	);
}

/** Registers the tools over the caller's workstation presets: list, read, create, change, delete. */
function registerWorkstationPresetTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_workstation_presets",
		{
			annotations: read,
			description:
				"List the caller's workstation presets, saved settings new workstations start from, with their env redacted.",
		},
		async () => await envRedacted(await api("GET", "/workstation-presets")),
	);

	server.registerTool(
		"get_workstation_preset",
		{
			annotations: read,
			description:
				"A workstation preset's settings and login wall policy, secret-looking env values redacted.",
			inputSchema: z.object({ presetId }),
		},
		async ({ presetId: id }) =>
			await envRedacted(await api("GET", presetPath(id))),
	);

	server.registerTool(
		"create_workstation_preset",
		{
			annotations: change,
			description:
				"Save a workstation preset for the caller; defaults fill the settings left out and its login wall is off unless sent. A workstation created from it on the dashboard starts with its settings and login wall.",
			inputSchema: workstationPresetApiBody,
		},
		async (input) =>
			await envRedacted(await api("POST", "/workstation-presets", input)),
	);

	server.registerTool(
		"update_workstation_preset",
		{
			annotations: change,
			description:
				"Change a workstation preset's fields, keeping the ones left out.",
			inputSchema: updateWorkstationPresetApiBody.extend({
				env: envChanges,
				presetId,
			}),
		},
		async ({ presetId: id, ...changes }) =>
			await patchWithEnv(api, presetPath(id), changes),
	);

	server.registerTool(
		"delete_workstation_preset",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description:
				"Delete a workstation preset. Workstations made from it are untouched.",
			inputSchema: z.object({ presetId }),
		},
		async ({ presetId: id }) =>
			await asResult(await api("DELETE", presetPath(id))),
	);
}

/** Registers the workstation and workstation preset tools. */
export function registerWorkstationTools(
	server: McpServer,
	api: ApiCall,
): void {
	registerWorkstationCrudTools(server, api);
	registerWorkstationLifecycleTools(server, api);
	registerWorkstationPresetTools(server, api);
}
