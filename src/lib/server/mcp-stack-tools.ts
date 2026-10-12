import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	createStackApiBody,
	updateStackApiBody,
} from "#lib/server/validation/api.js";

/** Registers the stack tools: listing, reading, creating and changing the groups services share a network in. */
export function registerStackTools(server: McpServer, api: ApiCall): void {
	const stackId = z.string().describe("The stack's id, from list_stacks");
	const path = (id: string) => `/stacks/${encodeURIComponent(id)}`;

	server.registerTool(
		"list_stacks",
		{
			annotations: read,
			description:
				"List stacks, the groups services share a network in, with their id, name, slug and parent stack.",
		},
		async () => asResult(await api("GET", "/stacks?perPage=100")),
	);

	server.registerTool(
		"get_stack",
		{
			annotations: read,
			description:
				"One stack: name, slug, description, icon and the stack it's nested in. Its services are the ones list_services shows with its id as stackId.",
			inputSchema: z.object({ stackId }),
		},
		async ({ stackId: id }) => asResult(await api("GET", path(id))),
	);

	server.registerTool(
		"create_stack",
		{
			annotations: change,
			description:
				"Create an empty stack. Services join it through create_service or update_service's stackId.",
			inputSchema: createStackApiBody,
		},
		async (input) => asResult(await api("POST", "/stacks", input)),
	);

	server.registerTool(
		"update_stack",
		{
			annotations: change,
			description:
				"Rename a stack, change its slug, description or icon, or nest it in another stack, keeping what's left out.",
			inputSchema: updateStackApiBody.extend({ stackId }),
		},
		async ({ stackId: id, ...changes }) =>
			asResult(await api("PATCH", path(id), changes)),
	);
}
