import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	statusPageApiBody,
	updateStatusPageApiBody,
} from "#lib/server/validation/api-resources.js";

/** Registers the tools that list, create, change and delete status pages. */
export function registerStatusPageTools(server: McpServer, api: ApiCall): void {
	const statusPageId = z
		.string()
		.describe("The status page's id, from list_status_pages");
	const path = (id: string) => `/status-pages/${encodeURIComponent(id)}`;

	server.registerTool(
		"list_status_pages",
		{
			annotations: read,
			description:
				"List status pages: name, slug, whether they're public, their domains and scope (global: every service, stack: one stack's, custom: the services picked).",
		},
		async () => asResult(await api("GET", "/status-pages")),
	);

	server.registerTool(
		"create_status_page",
		{
			annotations: change,
			description:
				"Create a status page showing every service (scope global), one stack's (stack, with stackId) or the ones picked (custom, with services). Private unless isPublic.",
			inputSchema: statusPageApiBody,
		},
		async (input) => asResult(await api("POST", "/status-pages", input)),
	);

	server.registerTool(
		"update_status_page",
		{
			annotations: change,
			description:
				"Change a status page's fields, keeping the ones left out. services replaces the picked ones.",
			inputSchema: updateStatusPageApiBody.extend({ statusPageId }),
		},
		async ({ statusPageId: id, ...changes }) =>
			asResult(await api("PATCH", path(id), changes)),
	);

	server.registerTool(
		"delete_status_page",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description: "Delete a status page. The services it shows are untouched.",
			inputSchema: z.object({ statusPageId }),
		},
		async ({ statusPageId: id }) => asResult(await api("DELETE", path(id))),
	);
}
