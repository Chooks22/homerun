import {
	type CallToolResult,
	createMcpHandler,
	McpServer,
} from "@modelcontextprotocol/server";
import type { RequestEvent } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "#lib/config.js";
import { MCP_PATH, mcpAllowed } from "#lib/oidc-provider.js";
import { APP_VERSION } from "#lib/server/app-version.js";
import { registerAdminTools } from "#lib/server/mcp-admin-tools.js";
import { registerCronJobTools } from "#lib/server/mcp-cron-job-tools.js";
import { registerEnvironmentTools } from "#lib/server/mcp-environment-tools.js";
import { registerNotificationTools } from "#lib/server/mcp-notification-tools.js";
import { registerObjectStorageTools } from "#lib/server/mcp-object-storage-tools.js";
import { registerPreviewTools } from "#lib/server/mcp-preview-tools.js";
import {
	mergeEnvChanges,
	REDACTED,
	restoreArgv,
} from "#lib/server/mcp-redact.js";
import { registerRedirectTools } from "#lib/server/mcp-redirect-tools.js";
import { registerScanTools } from "#lib/server/mcp-scan-tools.js";
import { registerStackTools } from "#lib/server/mcp-stack-tools.js";
import { registerStatusPageTools } from "#lib/server/mcp-status-page-tools.js";
import { registerSystemTools } from "#lib/server/mcp-system-tools.js";
import { registerTemplateTools } from "#lib/server/mcp-template-tools.js";
import {
	type ApiCall,
	asResult,
	change,
	errorResult,
	read,
} from "#lib/server/mcp-tool-kit.js";
import { registerVersionTools } from "#lib/server/mcp-version-tools.js";
import { registerVolumeTools } from "#lib/server/mcp-volume-tools.js";
import { registerWorkstationTools } from "#lib/server/mcp-workstation-tools.js";

export type { ApiCall } from "#lib/server/mcp-tool-kit.js";

const INSTRUCTIONS = `Homerun is a self-hosted PaaS: each service is one Docker container or swarm service, routed by Traefik at its domains.

To diagnose a service: find its id with list_services, read get_service (status, container and swarm ids) and get_service_config (its settings grouped like the dashboard tabs), then service_logs, list_deployments (each deploy attempt's error and log, the place to look when a deploy failed) and list_revisions (each revision's health and the reason it failed). When the app reports errors through a Sentry SDK, list_errors and get_error give the grouped exceptions with stack traces and links to the source, and update_error resolves or ignores one. Swarm logs can interleave every task generation, dead ones included, so check timestamps before blaming a line on the running task. Services in one stack reach each other by slug on the stack's network. list_notifications is the caller's in-app feed (failed or rolled back deploys, unhealthy revisions, app errors, resource alerts), a quick way to see what went wrong lately.

Stacks group services: list_stacks, get_stack, create_stack and update_stack. create_service makes a service from scratch or from a template (list_templates, get_template); it isn't deployed until deploy_service. A service can have environments (list_environments, create_environment, update_environment: copies running another ref, each one a service of its own), pull request previews (list_previews, get_preview, and promote_preview deploys a healthy preview's image to its service) and release channels (get_release_channels, set_release_channels). list_scans, get_scan and scan_service cover its image's vulnerability scans.

For backups and other background work: list_volumes gives each volume's backup settings, list_backups every run with its outcome, error and its job's last progress, get_job a job's full log, attempts and progressAt (a running job whose progressAt stops moving is stuck), list_jobs what's queued, running or failed, and run_backup queues a backup now. create_volume and update_volume change a volume and its backup settings (list_backup_destinations gives where it can back up to); list_volume_mounts, mount_volume, update_volume_mount and unmount_volume change where it's mounted, from the service's next deploy.

Cron jobs run a container, a script or a host command on a schedule: list_cron_jobs and get_cron_job show their config, create_cron_job, update_cron_job (enabled turns the schedule on or off) and delete_cron_job change them, run_cron_job runs one now, list_cron_job_runs gives its latest runs and get_cron_job_run one run's output, the place to look when a job failed.

Object storage (S3) is the built-in store and every S3-compatible provider connected to this instance: list_object_stores shows them, list_buckets and get_bucket a store's buckets with their expiry and whether they're public (a public bucket's objects are served to anyone at <instance>/public/<storeId>/<bucket>/<key>), create_bucket, update_bucket and delete_bucket (empty buckets only) change them.

Redirects send a hostname, or a path under it, to another URL through Traefik, with no container: list_redirects shows them, create_redirect, update_redirect (enabled: false turns one off) and delete_redirect change them. Status pages show services' uptime: list_status_pages, create_status_page, update_status_page and delete_status_page. Notification channels are where alerts are sent: list_notification_channels, create_notification_channel, update_notification_channel and delete_notification_channel; mark_notifications_read clears the in-app feed.

An image service can be pinned to a version and watched for updates: get_service_version shows its pin and the update its last check found (with that update's trial run), find_pin_tags the registry tags matching what it runs, pin_service and unpin_service change the pin, set_update_watch turns the watch on or off, check_service_updates checks now and apply_service_update moves it onto the update and deploys.

get_monitoring and get_service_monitoring sum up traffic, availability and CPU and memory over a period, the latter with a service's latest uptime probe beats. With access to System: list_system_logs is Homerun's own warnings and errors, list_system_containers and system_container_logs its own containers (Traefik's logs included), preview_docker_cleanup and run_docker_cleanup reclaim disk space. DNS: list_domains, list_dns_records, create_dns_record, update_dns_record and delete_dns_record. The built-in image registry: list_registry_repositories lists the images it holds with their tags, digests and the services using them, list_registry_tags one repository's tags. get_registry_settings, list_registry_tokens, list_remote_hosts, list_users, list_git_providers and list_dns_connections read admin config; none of it is changed here, and no credential is ever returned.

Dev workstations are the caller's own browser IDE containers: list_workstations and get_workstation show them (env redacted, never the IDE password), create_workstation, update_workstation (its login wall included), start_workstation, stop_workstation, recreate_workstation (a fresh container from its current settings and image) and delete_workstation (deleteVolume also drops the home volume) change them; list_workstation_presets, get_workstation_preset, create_workstation_preset, update_workstation_preset and delete_workstation_preset manage the presets new ones start from, login wall included.

To fix one: update_service changes settings (applied on the next deploy), deploy_service rolls them out, restart_service restarts without redeploying, rollback_service redeploys an earlier revision. Say what you're about to change before changing it.`;

const serviceId = z.string().describe("The service's id, from list_services");

/** A path under a service, with its id escaped. */
function servicePath(id: string, suffix = ""): string {
	return `/services/${encodeURIComponent(id)}${suffix}`;
}

/** Registers the tool that reads a service's deploy attempts, failed ones included. */
function registerDeploymentTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_deployments",
		{
			annotations: read,
			description:
				"A service's latest deploy attempts, newest first, failed ones included: each one's status, error and progress log. Read this when a deploy failed, since a deploy that never started a container leaves nothing in service_logs.",
			inputSchema: z.object({
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe("How many deployments to return (default 10)"),
				serviceId,
			}),
		},
		async ({ limit, serviceId: id }) =>
			asResult(
				await api(
					"GET",
					servicePath(id, `/deployments${limit ? `?limit=${limit}` : ""}`),
				),
			),
	);
}

/** Registers the tools that read the errors a service's apps reported through a Sentry SDK. */
function registerErrorTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_errors",
		{
			annotations: read,
			description:
				"A service's error issues from its error tracking (Sentry SDKs reporting to Homerun), most recently seen first: each one's id, title, culprit (the innermost in-app frame), level, event count, users affected, first and last seen, releases and status.",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe("Only issues whose title or culprit matches this term"),
				serviceId,
				status: z
					.enum(["unresolved", "resolved", "ignored", "all"])
					.optional()
					.describe("Which issues to list (default unresolved)"),
			}),
		},
		async ({ search, serviceId: id, status }) => {
			const query = new URLSearchParams({ perPage: "50" });
			if (search) {
				query.set("q", search);
			}
			if (status) {
				query.set("status", status);
			}
			return asResult(await api("GET", servicePath(id, `/errors?${query}`)));
		},
	);

	server.registerTool(
		"get_error",
		{
			annotations: read,
			description:
				"One error issue with its newest event: the exception chain, the stack trace (oldest call first, each frame with its file, line, in-app flag and surrounding source lines), breadcrumbs, tags, request, user, release and environment, plus repository links to the in-app frames at the deployed commit. Read this to find where in the code an error comes from.",
			inputSchema: z.object({
				eventId: z
					.string()
					.optional()
					.describe(
						"A specific event of the issue, from olderEventId/newerEventId",
					),
				issueId: z.string().describe("The issue's id, from list_errors"),
				serviceId,
			}),
		},
		async ({ eventId, issueId, serviceId: id }) =>
			asResult(
				await api(
					"GET",
					servicePath(
						id,
						`/errors/${encodeURIComponent(issueId)}${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`,
					),
				),
			),
	);
	server.registerTool(
		"update_error",
		{
			annotations: change,
			description:
				"Resolve, ignore or reopen an error issue. A resolved issue that happens again reopens as a regression and notifies; an ignored one keeps counting but never notifies.",
			inputSchema: z.object({
				issueId: z.string().describe("The issue's id, from list_errors"),
				serviceId,
				status: z.enum(["unresolved", "resolved", "ignored"]),
			}),
		},
		async ({ issueId, serviceId: id, status }) =>
			asResult(
				await api(
					"PATCH",
					servicePath(id, `/errors/${encodeURIComponent(issueId)}`),
					{ status },
				),
			),
	);
}

/** Registers the tools that read and replace what a service depends on. */
function registerDependencyTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_dependencies",
		{
			annotations: read,
			description:
				"What a service depends on and what depends on it, each with its id, name, slug and source: recorded (a stored dependency, the only kind that sets start order), env (an env value names the other's slug as a host) or both.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("GET", servicePath(id, "/dependencies"))),
	);

	server.registerTool(
		"set_dependencies",
		{
			annotations: change,
			description:
				"Replace the services a service is recorded as depending on, which are started before it. Env vars aren't changed. Refused when one of them already depends on this service.",
			inputSchema: z.object({
				dependsOn: z
					.array(z.string())
					.describe(
						"Every service id it should depend on, from list_services; an empty list clears them",
					),
				serviceId,
			}),
		},
		async ({ dependsOn, serviceId: id }) =>
			asResult(
				await api("PUT", servicePath(id, "/dependencies"), { dependsOn }),
			),
	);
}

/** Registers the tools that read one service or find it: list, record, config, logs and revisions. */
function registerReadTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_services",
		{
			annotations: read,
			description:
				"List services with their id, name, slug, image, tag, status and stack; a pull request preview also names the service it previews (previewOf).",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe("Only services whose name or slug matches this term"),
			}),
		},
		async ({ search }) => {
			const query = new URLSearchParams({ perPage: "100" });
			if (search) {
				query.set("q", search);
			}
			const response = await api("GET", `/services?${query}`);
			if (!response.ok) {
				return await asResult(response);
			}
			const rows = (await response.json()) as Record<string, unknown>[];
			const summary = rows.map((row) => ({
				currentStatus: row.currentStatus,
				id: row.id,
				image: row.image,
				name: row.name,
				previewOf: row.previewParentId ?? undefined,
				slug: row.slug,
				stackId: row.stackId,
				tag: row.tag,
			}));
			return { content: [{ text: JSON.stringify(summary), type: "text" }] };
		},
	);

	server.registerTool(
		"get_service",
		{
			annotations: read,
			description:
				"A service's full record: status, container and swarm ids, image, domains and every setting as stored. Env vars marked secret, secret-looking or credential-looking env vars, URL passwords and password arguments are redacted.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) => asResult(await api("GET", servicePath(id))),
	);

	server.registerTool(
		"get_service_config",
		{
			annotations: read,
			description:
				"A service's settings grouped by dashboard tab (source, env, volumes, networking, compute, runtime, security, settings). Env vars marked secret, secret-looking or credential-looking env vars, URL passwords and password arguments are redacted.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("GET", servicePath(id, "/config"))),
	);

	server.registerTool(
		"service_logs",
		{
			annotations: read,
			description:
				"The latest lines of a service's container or swarm task logs.",
			inputSchema: z.object({
				serviceId,
				tail: z
					.number()
					.int()
					.min(1)
					.max(10_000)
					.optional()
					.describe("How many of the latest lines to return (default 200)"),
			}),
		},
		async ({ serviceId: id, tail }) =>
			asResult(
				await api(
					"GET",
					servicePath(id, `/logs${tail ? `?tail=${tail}` : ""}`),
				),
			),
	);

	server.registerTool(
		"list_revisions",
		{
			annotations: read,
			description:
				"A service's deployed revisions, newest first, with each one's image, health and failure reason.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("GET", servicePath(id, "/revisions"))),
	);
}

/** Registers the read-only tools about the whole instance: host usage and version. */
function registerInstanceTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"system_stats",
		{
			annotations: read,
			description: "The host's CPU, memory and disk usage.",
		},
		async () => asResult(await api("GET", "/system-stats")),
	);

	server.registerTool(
		"instance_status",
		{
			annotations: read,
			description:
				"The instance's running version, release channel and whether an update is available.",
		},
		async () => asResult(await api("GET", "/instance/update")),
	);
}

/** Registers the tools over volumes, backup runs and queue jobs, and the one that queues a backup. */
function registerBackupTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_volumes",
		{
			annotations: read,
			description:
				"List storage volumes with their backup settings: schedule, destination, last and next run.",
		},
		async () => asResult(await api("GET", "/volumes?perPage=100")),
	);

	server.registerTool(
		"list_backups",
		{
			annotations: read,
			description:
				"List backup and restore runs, newest first: outcome, error, size, and the job's id, status and last progress.",
			inputSchema: z.object({
				outcome: z
					.enum(["running", "success", "failed"])
					.optional()
					.describe("Only runs with this outcome"),
				volumeId: z
					.string()
					.optional()
					.describe("Only this volume's runs, id from list_volumes"),
			}),
		},
		async ({ outcome, volumeId }) => {
			const query = new URLSearchParams({ perPage: "50" });
			if (outcome) {
				query.set("outcome", outcome);
			}
			if (volumeId) {
				query.set("volume", volumeId);
			}
			return asResult(await api("GET", `/backups?${query}`));
		},
	);

	server.registerTool(
		"get_job",
		{
			annotations: read,
			description:
				"A queue job's status, error, attempts, heartbeat, last progress and full log.",
			inputSchema: z.object({
				jobId: z
					.string()
					.describe("The job's id, from list_backups or list_jobs"),
			}),
		},
		async ({ jobId }) =>
			asResult(await api("GET", `/jobs/${encodeURIComponent(jobId)}`)),
	);

	server.registerTool(
		"list_jobs",
		{
			annotations: read,
			description:
				"List queue jobs (deploys, backups, cron jobs, cleanups, scans), running first. Admins only.",
			inputSchema: z.object({
				status: z
					.string()
					.optional()
					.describe(
						"Comma-separated statuses: queued, running, succeeded, failed, cancelled",
					),
			}),
		},
		async ({ status }) => {
			const query = new URLSearchParams({ perPage: "50" });
			if (status) {
				query.set("status", status);
			}
			return asResult(await api("GET", `/jobs?${query}`));
		},
	);

	server.registerTool(
		"run_backup",
		{
			annotations: change,
			description:
				"Queue a backup of a volume now and return its job id, follow it with get_job.",
			inputSchema: z.object({
				volumeId: z.string().describe("The volume's id, from list_volumes"),
			}),
		},
		async ({ volumeId }) =>
			asResult(
				await api("POST", `/volumes/${encodeURIComponent(volumeId)}/backup`),
			),
	);
}

/**
 * Patches a service for `update_service`. Env changes are merged into the
 * stored vars (`null` deletes one) rather than replacing them, and anything
 * the agent only saw redacted (an env value, a URL's password, a password
 * argument in the command) keeps its stored value; a placeholder that doesn't
 * match anything stored is refused instead of written, and an uploaded icon
 * sent back as the "uploaded" label it was read as is left alone.
 */
async function updateService(
	api: ApiCall,
	id: string,
	changes: Record<string, unknown>,
): Promise<CallToolResult> {
	const { icon, ...rest } = changes;
	const sent = icon === "uploaded" ? rest : changes;
	const touchesSecrets = ["command", "entrypoint", "envVars"].some(
		(key) => key in sent,
	);
	if (!touchesSecrets) {
		return asResult(await api("PATCH", servicePath(id), sent));
	}
	const current = await api("GET", servicePath(id));
	if (!current.ok) {
		return asResult(current);
	}
	const stored = (await current.json()) as {
		command: string[] | null;
		entrypoint: string[] | null;
		envVars: Record<string, string> | null;
		secretEnvKeys?: string[];
	};
	try {
		const patch = { ...sent };
		if (patch.envVars && typeof patch.envVars === "object") {
			patch.envVars = mergeEnvChanges(
				patch.envVars as Record<string, unknown>,
				stored.envVars ?? {},
				new Set(stored.secretEnvKeys ?? []),
			);
		}
		for (const key of ["command", "entrypoint"] as const) {
			if (Array.isArray(patch[key])) {
				patch[key] = restoreArgv(patch[key] as unknown[], stored[key]);
			}
		}
		return asResult(await api("PATCH", servicePath(id), patch));
	} catch (err) {
		return errorResult(err);
	}
}

/** Registers the tools that change a service: settings, deploy, restart/start/stop and rollback. */
function registerChangeTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"update_service",
		{
			annotations: change,
			description:
				"Change a service's settings. Takes effect on its next deploy_service.",
			inputSchema: z.object({
				changes: z
					.record(z.string(), z.unknown())
					.describe(
						`The fields to change, as PATCH /services/{serviceId} takes them, e.g. {"envVars": {"KEY": "value"}}. envVars is merged into the stored vars: send only the ones to change, null deletes one. Anything left as you read it, "${REDACTED}" included, keeps its stored value.`,
					),
				serviceId,
			}),
		},
		({ changes, serviceId: id }) => updateService(api, id, changes),
	);

	server.registerTool(
		"deploy_service",
		{
			annotations: change,
			description:
				"Deploy a service with its current settings and wait for the result, optionally switching its image tag first.",
			inputSchema: z.object({
				serviceId,
				tag: z
					.string()
					.optional()
					.describe("Switch an image-based service to this image tag first"),
				environment: z
					.enum(["stable", "canary"])
					.optional()
					.describe(
						"With release channels on, canary deploys the service's canary from its canary branch; stable (the default) the service itself",
					),
			}),
		},
		async ({ environment, serviceId: id, tag }) =>
			asResult(
				await api(
					"POST",
					servicePath(id, "/deploy"),
					tag || environment ? { environment, tag } : undefined,
				),
			),
	);

	for (const [action, verb] of [
		["restart", "Restart"],
		["start", "Start"],
		["stop", "Stop"],
	] as const) {
		server.registerTool(
			`${action}_service`,
			{
				annotations: change,
				description: `${verb} a service's container or swarm service, without redeploying it.`,
				inputSchema: z.object({ serviceId }),
			},
			async ({ serviceId: id }) =>
				asResult(await api("POST", servicePath(id, `/${action}`))),
		);
	}

	server.registerTool(
		"rollback_service",
		{
			annotations: change,
			description:
				"Redeploy one of a service's earlier revisions (default: the previous one) and wait for it.",
			inputSchema: z.object({
				restoreConfig: z
					.boolean()
					.optional()
					.describe(
						"Also restore the env vars, resources and networking that revision ran with",
					),
				revisionId: z
					.string()
					.optional()
					.describe("The revision to redeploy, from list_revisions"),
				serviceId,
			}),
		},
		async ({ restoreConfig, revisionId, serviceId: id }) =>
			asResult(
				await api(
					"POST",
					servicePath(
						id,
						`/revisions/${encodeURIComponent(revisionId ?? "previous")}/deploy${restoreConfig ? "?restoreConfig=true" : ""}`,
					),
				),
			),
	);
}

/**
 * Homerun's MCP server: tools for an AI agent to diagnose and fix services,
 * each one a call to the REST API through `api`, so they run with the caller's
 * own permissions (a developer or read-only key can't do more here than on
 * the API). Deleting a service, a stack or an environment is deliberately
 * not a tool.
 */
export function createHomerunMcpServer(api: ApiCall): McpServer {
	const server = new McpServer(
		{ name: "homerun", version: APP_VERSION },
		{ instructions: INSTRUCTIONS },
	);
	registerReadTools(server, api);
	registerDeploymentTools(server, api);
	registerDependencyTools(server, api);
	registerErrorTools(server, api);
	registerInstanceTools(server, api);
	registerBackupTools(server, api);
	registerRedirectTools(server, api);
	registerObjectStorageTools(server, api);
	registerChangeTools(server, api);
	registerStackTools(server, api);
	registerTemplateTools(server, api);
	registerEnvironmentTools(server, api);
	registerPreviewTools(server, api);
	registerScanTools(server, api);
	registerVolumeTools(server, api);
	registerCronJobTools(server, api);
	registerStatusPageTools(server, api);
	registerNotificationTools(server, api);
	registerWorkstationTools(server, api);
	registerVersionTools(server, api);
	registerSystemTools(server, api);
	registerAdminTools(server, api);
	return server;
}

const FORWARDED_AUTH_HEADERS = ["authorization", "cookie", "x-api-key"];

/**
 * Serves one MCP request for the signed-in caller: an OAuth access token from
 * an MCP client like claude.ai, an API key, or a dashboard session, all of
 * which `hooks.server.ts` has already turned into `locals.user`. Anyone else
 * gets the 401 whose `WWW-Authenticate` points MCP clients at the protected
 * resource metadata, which is how they find where to sign in. Tool calls go
 * back through the REST API with the caller's own credentials.
 */
export async function serveMcp(event: RequestEvent): Promise<Response> {
	const { fetch, locals, request } = event;
	if (!(config.auth.origin && mcpAllowed(config.auth.origin))) {
		return new Response(
			JSON.stringify({
				error:
					"The MCP server needs the dashboard served over HTTPS: set its URL to an https:// one in Settings → General.",
			}),
			{ headers: { "content-type": "application/json" }, status: 404 },
		);
	}
	if (!locals.user) {
		const origin = config.auth.origin?.replace(/\/+$/, "");
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			headers: {
				"content-type": "application/json",
				"www-authenticate": origin
					? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`
					: "Bearer",
			},
			status: 401,
		});
	}
	const credentials = new Headers();
	for (const name of FORWARDED_AUTH_HEADERS) {
		const value = request.headers.get(name);
		if (value) {
			credentials.set(name, value);
		}
	}
	const api: ApiCall = (method, path, body) => {
		const headers = new Headers(credentials);
		if (body !== undefined) {
			headers.set("content-type", "application/json");
		}
		const init: RequestInit = { headers, method };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}
		return fetch(`/api/v1${path}`, init);
	};
	return await createMcpHandler(() => createHomerunMcpServer(api)).fetch(
		request,
	);
}
