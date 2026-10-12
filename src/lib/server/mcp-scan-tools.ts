import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";

/** Registers the tools over a service's image vulnerability scans: listing, reading one with its findings, and queueing one. */
export function registerScanTools(server: McpServer, api: ApiCall): void {
	const serviceId = z.string().describe("The service's id, from list_services");
	const scansPath = (id: string, suffix = "") =>
		`/services/${encodeURIComponent(id)}/scans${suffix}`;

	server.registerTool(
		"list_scans",
		{
			annotations: read,
			description:
				"A service's image vulnerability scans, newest first, without findings: each one's image, digest, status and counts by severity.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) =>
			asResult(await api("GET", scansPath(id, "?perPage=50"))),
	);

	server.registerTool(
		"get_scan",
		{
			annotations: read,
			description:
				"One image scan with its findings, most severe first (vulnerability id, package, installed and fixed versions, severity), the latest scan unless scanId is given.",
			inputSchema: z.object({
				scanId: z
					.string()
					.optional()
					.describe("The scan's id, from list_scans"),
				serviceId,
			}),
		},
		async ({ scanId, serviceId: id }) =>
			asResult(
				await api(
					"GET",
					scansPath(id, `/${scanId ? encodeURIComponent(scanId) : "latest"}`),
				),
			),
	);

	server.registerTool(
		"scan_service",
		{
			annotations: change,
			description:
				"Queue a vulnerability scan of a service's deployed image and return its job id: follow it with get_job, then read the result with get_scan.",
			inputSchema: z.object({ serviceId }),
		},
		async ({ serviceId: id }) => asResult(await api("POST", scansPath(id))),
	);
}
