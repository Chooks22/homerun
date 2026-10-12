import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";

/** Registers the tools that browse templates and create a service, from one or from scratch. */
export function registerTemplateTools(server: McpServer, api: ApiCall): void {
	server.registerTool(
		"list_templates",
		{
			annotations: read,
			description:
				"List the service templates the caller can use, built-in and custom: each one's id, name, description, category and image.",
			inputSchema: z.object({
				search: z
					.string()
					.optional()
					.describe("Only templates whose name matches this term"),
			}),
		},
		async ({ search }) => {
			const query = new URLSearchParams({ perPage: "200" });
			if (search) {
				query.set("q", search);
			}
			const response = await api("GET", `/templates?${query}`);
			if (!response.ok) {
				return await asResult(response);
			}
			const rows = (await response.json()) as Record<string, unknown>[];
			const summary = rows.map((row) => ({
				builtin: row.ownerId === null,
				category: row.category,
				description: row.description,
				id: row.id,
				image: row.image,
				name: row.name,
				tag: row.tag,
			}));
			return { content: [{ text: JSON.stringify(summary), type: "text" }] };
		},
	);

	server.registerTool(
		"get_template",
		{
			annotations: read,
			description:
				"One template's full settings: image and tag, port, env vars, command, resources, runtime options. Secret-looking env vars are redacted.",
			inputSchema: z.object({
				templateId: z
					.string()
					.describe("The template's id, from list_templates"),
			}),
		},
		async ({ templateId }) =>
			asResult(
				await api("GET", `/templates/${encodeURIComponent(templateId)}`),
			),
	);

	server.registerTool(
		"create_service",
		{
			annotations: change,
			description:
				"Create a service, from a template or from scratch. It isn't deployed: deploy_service does that.",
			inputSchema: z.object({
				settings: z
					.record(z.string(), z.unknown())
					.describe(
						'The fields as POST /services takes them, the same ones update_service changes plus name and slug, e.g. {"name": "Web", "slug": "web", "image": "nginx", "tag": "latest", "containerPort": 80, "stackId": "..."}, or buildSource "git" with gitUrl instead of image. With templateId, name and slug default to the template\'s and anything sent overrides it.',
					),
				templateId: z
					.string()
					.optional()
					.describe(
						"Create it from this template (image, variables, volumes and linked services), id from list_templates",
					),
			}),
		},
		async ({ settings, templateId }) =>
			asResult(
				await api(
					"POST",
					"/services",
					templateId ? { ...settings, templateId } : settings,
				),
			),
	);
}
