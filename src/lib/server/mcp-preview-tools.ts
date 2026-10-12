import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";

/** Registers the tools over a service's pull request previews: listing, reading and promoting one. */
export function registerPreviewTools(server: McpServer, api: ApiCall): void {
	const serviceId = z
		.string()
		.describe("The previewed service's id, from list_services");
	const prNumber = z
		.number()
		.int()
		.min(1)
		.describe("The pull request's number, from list_previews");
	const previewsPath = (id: string, suffix = "") =>
		`/services/${encodeURIComponent(id)}/previews${suffix}`;

	server.registerTool(
		"list_previews",
		{
			annotations: read,
			description:
				"A service's open pull request previews, newest pull request first: each one's URL, the revision it runs with its health, and its latest deploy attempt.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) => asResult(await api("GET", previewsPath(id))),
	);

	server.registerTool(
		"get_preview",
		{
			annotations: read,
			description:
				"One pull request's preview: its URL, the commit and revision it runs, the revision's health and its latest deploy attempt.",
			inputSchema: z.object({ prNumber, serviceId }),
		},
		async ({ prNumber: pr, serviceId: id }) =>
			asResult(await api("GET", previewsPath(id, `/${pr}`))),
	);

	server.registerTool(
		"promote_preview",
		{
			annotations: change,
			description:
				"Deploy the exact image a healthy preview runs to the service it previews, without rebuilding, and return the queue job id to follow with get_job. Refused while the preview has no running revision or isn't healthy.",
			inputSchema: z.object({
				commit: z
					.string()
					.optional()
					.describe(
						"Only promote if the preview runs this commit (7 to 40 hex characters)",
					),
				prNumber,
				serviceId,
			}),
		},
		async ({ commit, prNumber: pr, serviceId: id }) =>
			asResult(
				await api(
					"POST",
					previewsPath(id, `/${pr}/promote`),
					commit ? { commit } : {},
				),
			),
	);
}
