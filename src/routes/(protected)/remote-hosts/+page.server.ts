import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { NodeEnrollmentDTO } from "#lib/dto/node-enrollment-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { enrollCommand } from "#lib/server/node-install-script.js";
import { AgentClientService } from "#lib/services/agent-client.service.js";
import { DockerService } from "#lib/services/docker.service.js";
import { RemoteHostSettingsService } from "#lib/services/remote-host-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("RemoteHosts");

export interface AgentStatus {
	reachable: boolean;
	version: string | null;
	error: string | null;
}

/**
 * Live `GET /v1/health` against every `kind: "agent"` host, in parallel, so
 * the list page can actually show *why* an agent shows as unusable (down,
 * wrong URL, version) instead of the same static caveat regardless of
 * whether the agent is even reachable. Best-effort : a single unreachable
 * agent shouldn't fail the whole page load, same posture as
 * AgentClientService.checkHealth's own caller at Add-Host-save time.
 */
async function checkAgentStatuses(
	hosts: RemoteHostDTO[],
): Promise<Record<string, AgentStatus>> {
	const agentHosts = hosts.filter((h) => h.kind === "agent" && h.agentUrl);
	const entries = await Promise.all(
		agentHosts.map(async (h) => {
			try {
				const { version } = await AgentClientService.checkHealth(
					h.agentUrl as string,
				);
				return [h.id, { error: null, reachable: true, version }] as const;
			} catch (error) {
				return [
					h.id,
					{
						error: error instanceof Error ? error.message : String(error),
						reachable: false,
						version: null,
					},
				] as const;
			}
		}),
	);
	return Object.fromEntries(entries);
}

/** The swarm's nodes when this instance runs in swarm mode, empty otherwise or when the worker can't answer. */
async function swarmNodes(swarmMode: boolean) {
	return swarmMode ? await DockerService.listSwarmNodes().catch(() => []) : [];
}

export const load = async ({ locals, parent, url }) => {
	const { preferences } = await parent();
	const swarmMode =
		(await InstanceSettingsDTO.get()).orchestrationMode === "swarm";
	const query = parseListQuery(
		url,
		{
			filterKeys: ["kind"],
			sortKeys: sortKeysOf(BASE_SORTS),
		},
		preferences.perPage,
	);
	const paged = await RemoteHostDTO.listPaged(query);
	const canWrite = can(locals.permissions, "remote-hosts", "write");
	const [agentStatuses, nodes, enrollments] = await Promise.all([
		checkAgentStatuses(paged.items),
		canWrite ? swarmNodes(swarmMode) : [],
		canWrite ? NodeEnrollmentDTO.listPending() : [],
	]);
	return {
		agentStatuses,
		canWrite,
		enrollments: enrollments.map((e) => e.summary()),
		swarmMode,
		swarmNodes: nodes,
		filtered: query.active,
		hosts: paged.items.map((h) => h.toJSON()),
		page: paged.page,
		perPage: paged.perPage,
		total: paged.total,
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const hostId = formData.get("hostId") as string | null;
		if (!hostId) {
			return fail(400, { error: "Missing host id." });
		}

		const host = await RemoteHostDTO.get(hostId);
		if (!host) {
			return fail(404, { error: "Remote host not found." });
		}

		await RemoteHostSettingsService.remove(host);
		logger.info(`Remote host deleted: host=${hostId} user=${locals.user.id}`);
		return { success: true };
	},
	enroll: async ({ request, locals, url }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const buildServer = formData.get("buildServer") === "on";
		const swarmNode = formData.get("swarmNode") === "on";
		if (!(buildServer || swarmNode)) {
			return fail(400, { error: "Pick at least one role for the server." });
		}
		if (
			swarmNode &&
			(await InstanceSettingsDTO.get()).orchestrationMode !== "swarm"
		) {
			return fail(400, {
				error: "Switch Settings → Docker to Swarm before adding swarm nodes.",
			});
		}
		const name = (formData.get("name") as string | null)?.trim() || null;
		const { token } = await NodeEnrollmentDTO.create({
			buildServer,
			name,
			swarmNode,
			userId: locals.user.id,
		});
		logger.info(
			`Server enrollment created: buildServer=${buildServer} swarmNode=${swarmNode} user=${locals.user.id}`,
		);
		return { command: enrollCommand(config.auth.origin ?? url.origin, token) };
	},
	revokeEnrollment: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const id = (await request.formData()).get("enrollmentId") as string | null;
		const enrollment = id ? await NodeEnrollmentDTO.get(id) : null;
		if (!enrollment) {
			return fail(404, { error: "Enrollment not found." });
		}
		await enrollment.delete();
		return { success: true };
	},
	removeNode: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const nodeId = (await request.formData()).get("nodeId") as string | null;
		if (!nodeId) {
			return fail(400, { error: "Missing node id." });
		}
		try {
			await DockerService.removeSwarmNode(nodeId);
		} catch (error) {
			return fail(502, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		logger.info(`Swarm node removed: node=${nodeId} user=${locals.user.id}`);
		return { success: true };
	},
};
