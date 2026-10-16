import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	updateVolumeApiBody,
	updateVolumeMountApiBody,
	volumeApiBody,
	volumeMountApiBody,
} from "#lib/server/validation/api-resources.js";

/** Registers the tools that change storage volumes and their backup settings, mount them into services, and list backup destinations. */
export function registerVolumeTools(server: McpServer, api: ApiCall): void {
	const volumeId = z.string().describe("The volume's id, from list_volumes");
	const mountId = z
		.string()
		.describe("The mount's id, from list_volume_mounts");
	const mountPath = (id: string) => `/volume-mounts/${encodeURIComponent(id)}`;

	server.registerTool(
		"create_volume",
		{
			annotations: change,
			description:
				"Register a storage volume: a Docker volume or a host path (bind), optionally with scheduled backups to a destination from list_backup_destinations.",
			inputSchema: volumeApiBody,
		},
		async (input) => asResult(await api("POST", "/volumes", input)),
	);

	server.registerTool(
		"update_volume",
		{
			annotations: change,
			description:
				"Change a volume's name, description or backup settings (on/off, schedule, destination, prefix, pre-backup command, stopping its services), keeping what's left out. Turning backups on without a schedule picks 0 3 * * *.",
			inputSchema: updateVolumeApiBody.extend({ volumeId }),
		},
		async ({ volumeId: id, ...changes }) =>
			asResult(
				await api("PATCH", `/volumes/${encodeURIComponent(id)}`, changes),
			),
	);

	server.registerTool(
		"list_volume_mounts",
		{
			annotations: read,
			description:
				"List where volumes are mounted: each mount's service, volume, path in the container and whether it's read-only.",
			inputSchema: z.object({
				serviceId: z
					.string()
					.optional()
					.describe("Only this service's mounts, id from list_services"),
				volumeId: volumeId.optional(),
			}),
		},
		async ({ serviceId, volumeId: id }) => {
			const response = await api("GET", "/volume-mounts");
			if (!(response.ok && (serviceId || id))) {
				return await asResult(response);
			}
			const rows = (await response.json()) as {
				serviceId: string;
				volumeId: string;
			}[];
			const matching = rows.filter(
				(row) =>
					(!serviceId || row.serviceId === serviceId) &&
					(!id || row.volumeId === id),
			);
			return { content: [{ text: JSON.stringify(matching), type: "text" }] };
		},
	);

	server.registerTool(
		"mount_volume",
		{
			annotations: change,
			description:
				"Mount a volume into a service at an absolute path. Applied on the service's next deploy_service.",
			inputSchema: volumeMountApiBody,
		},
		async (input) => asResult(await api("POST", "/volume-mounts", input)),
	);

	server.registerTool(
		"update_volume_mount",
		{
			annotations: change,
			description:
				"Change a mount's path or read-only flag. Applied on the service's next deploy_service.",
			inputSchema: updateVolumeMountApiBody.extend({ mountId }),
		},
		async ({ mountId: id, ...changes }) =>
			asResult(await api("PATCH", mountPath(id), changes)),
	);

	server.registerTool(
		"unmount_volume",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description:
				"Remove a volume's mount from a service, from its next deploy_service. The volume and its data stay.",
			inputSchema: z.object({ mountId }),
		},
		async ({ mountId: id }) => asResult(await api("DELETE", mountPath(id))),
	);

	server.registerTool(
		"list_backup_destinations",
		{
			annotations: read,
			description:
				"List backup destinations (S3, SFTP, SMB, WebDAV) volumes back up to: name, type, endpoint and bucket or path. Secrets are never returned.",
		},
		async () => asResult(await api("GET", "/backup-destinations?perPage=100")),
	);
}
