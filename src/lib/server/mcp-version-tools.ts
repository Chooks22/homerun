import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";

const serviceId = z.string().describe("The service's id, from list_services");

/** A path under a service's version routes, with its id escaped. */
function versionPath(id: string, suffix = ""): string {
	return `/services/${encodeURIComponent(id)}/version${suffix}`;
}

/** Registers the tools over an image service's version pinning and update checks, the Source tab's version panel. */
export function registerVersionTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"get_service_version",
		{
			annotations: read,
			description:
				"An image service's version pin (its tag, and the floating tag it was pinned from) and its last update check: the update found (availableTag), the check's error, and the trial run of that update (trialStatus, trialMessage with the failing container's last log lines).",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) => asResult(await api("GET", versionPath(id))),
	);

	server.registerTool(
		"find_pin_tags",
		{
			annotations: read,
			description:
				"The registry tags published for exactly the image an image service runs (matches), to pin it to with pin_service, and a tag to make on this host when none matches (suggestion).",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("GET", versionPath(id, "/pin"))),
	);

	server.registerTool(
		"pin_service",
		{
			annotations: change,
			description:
				"Pin an image service to a tag instead of a floating one like latest. A registry tag from find_pin_tags needs no redeploy; local: true tags the running image on this host first. unpin_service goes back.",
			inputSchema: z.object({
				local: z
					.boolean()
					.optional()
					.describe(
						"Make the tag on this host from the running image, when no registry tag matches",
					),
				serviceId,
				tag: z.string().describe("The tag to pin to"),
			}),
		},
		async ({ local, serviceId: id, tag }) =>
			asResult(await api("POST", versionPath(id, "/pin"), { local, tag })),
	);

	server.registerTool(
		"unpin_service",
		{
			annotations: change,
			description:
				"Put a pinned image service back on the floating tag it was pinned from, from its next deploy.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("DELETE", versionPath(id, "/pin"))),
	);

	server.registerTool(
		"set_update_watch",
		{
			annotations: change,
			description:
				"Turn an image service's update watch on or off (a newer release of its tag, or a new image behind a floating tag), and whether each update is tried in a throwaway container first. Turning the watch on runs the first check.",
			inputSchema: z.object({
				serviceId,
				updateCheckEnabled: z.boolean().optional(),
				updateTrialEnabled: z.boolean().optional(),
			}),
		},
		async ({ serviceId: id, ...watch }) =>
			asResult(await api("PATCH", versionPath(id), watch)),
	);

	server.registerTool(
		"check_service_updates",
		{
			annotations: change,
			description:
				"Ask the registry for an update to an image service now. A new update's trial run carries on in the background: read get_service_version again for its outcome.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("POST", versionPath(id, "/check"))),
	);

	server.registerTool(
		"apply_service_update",
		{
			annotations: change,
			description:
				"Move an image service onto the update its last check found and queue the deploy (a pinned service stays pinned, to the new tag). Follow it with list_deployments.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("POST", versionPath(id, "/update"))),
	);
}
