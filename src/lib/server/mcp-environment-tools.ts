import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import { releaseChannelsApiBody } from "#lib/server/validation/api.js";
import {
	serviceEnvironmentApiBody,
	updateServiceEnvironmentApiBody,
} from "#lib/server/validation/api-resources.js";

/** Registers the tools over a service's long-lived copies: its environments (staging, demo...) and its release channels' canary. */
export function registerEnvironmentTools(
	server: McpServer,
	api: ApiCall,
): void {
	const serviceId = z.string().describe("The service's id, from list_services");
	const environmentPath = (id: string) =>
		`/service-environments/${encodeURIComponent(id)}`;
	const channelsPath = (id: string) =>
		`/services/${encodeURIComponent(id)}/channels`;

	server.registerTool(
		"list_environments",
		{
			annotations: read,
			description:
				"List service environments (staging, demo...): copies of a service running another branch, tag or image tag under their own slug, each with its name, ref, domain and the service it copies. Each one is a service of its own, its id usable with get_service, deploy_service and the other service tools.",
			inputSchema: z.object({
				serviceId: serviceId
					.optional()
					.describe("Only this service's environments, id from list_services"),
			}),
		},
		async ({ serviceId: id }) => {
			const response = await api("GET", "/service-environments");
			if (!(response.ok && id)) {
				return await asResult(response);
			}
			const rows = (await response.json()) as { serviceId: string }[];
			return {
				content: [
					{
						text: JSON.stringify(rows.filter((row) => row.serviceId === id)),
						type: "text",
					},
				],
			};
		},
	);

	server.registerTool(
		"create_environment",
		{
			annotations: change,
			description:
				"Copy a service (settings, variables, volumes) into an environment running another ref, under its own slug. Only deployed when deploy is true.",
			inputSchema: serviceEnvironmentApiBody,
		},
		async (input) =>
			asResult(await api("POST", "/service-environments", input)),
	);

	server.registerTool(
		"update_environment",
		{
			annotations: change,
			description:
				"Point an environment at another ref or main domain, or set the variables it overrides, keeping what's left out. Takes effect on its next deploy_service.",
			inputSchema: updateServiceEnvironmentApiBody.extend({
				environmentId: z
					.string()
					.describe("The environment's id, from list_environments"),
			}),
		},
		async ({ environmentId, ...changes }) =>
			asResult(await api("PATCH", environmentPath(environmentId), changes)),
	);

	server.registerTool(
		"get_release_channels",
		{
			annotations: read,
			description:
				"A git service's release channels: whether they're on, the canary branch, the tag pattern that deploys the stable service, the ref it runs, and its <slug>-canary service.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) => asResult(await api("GET", channelsPath(id))),
	);

	server.registerTool(
		"set_release_channels",
		{
			annotations: change,
			description:
				"Turn a git service's release channels on or off, or change them. On: pushes to the canary branch deploy a <slug>-canary service, and pushed tags matching the pattern deploy this one. Turning them on creates and deploys the canary; off deletes it.",
			inputSchema: releaseChannelsApiBody.extend({ serviceId }),
		},
		async ({ serviceId: id, ...body }) =>
			asResult(await api("PATCH", channelsPath(id), body)),
	);
}
