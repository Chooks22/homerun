import { error, fail, redirect } from "@sveltejs/kit";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { AgentClientService } from "#lib/services/agent-client.service.js";
import {
	RemoteHostSettingsError,
	RemoteHostSettingsService,
} from "#lib/services/remote-host-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("RemoteHosts");

export const load = async ({ params, parent }) => {
	await parent();
	const host = await RemoteHostDTO.get(params.hostId);
	if (!host) {
		error(404, "Remote host not found");
	}

	// Same best-effort live health check as the list page (see its own
	// +page.server.ts), just for this one host.
	let agentStatus: {
		reachable: boolean;
		version: string | null;
		error: string | null;
	} | null = null;
	if (host.kind === "agent" && host.agentUrl) {
		try {
			const { version } = await AgentClientService.checkHealth(host.agentUrl);
			agentStatus = { error: null, reachable: true, version };
		} catch (err) {
			agentStatus = {
				error: err instanceof Error ? err.message : String(err),
				reachable: false,
				version: null,
			};
		}
	}

	return { agentStatus, host: host.toJSON() };
};

export const actions = {
	delete: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const host = await RemoteHostDTO.get(params.hostId);
		if (!host) {
			return fail(404, { error: "Remote host not found." });
		}
		await RemoteHostSettingsService.remove(host);
		logger.info(`Remote host deleted: host=${host.id} user=${locals.user.id}`);
		throw redirect(302, resolve("remote-hosts"));
	},

	update: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const host = await RemoteHostDTO.get(params.hostId);
		if (!host) {
			return fail(404, { error: "Remote host not found." });
		}
		const formData = await request.formData();
		const field = (key: string) => formData.get(key) as string | null;
		try {
			await RemoteHostSettingsService.update(host, {
				agentToken: field("agentToken"),
				agentUrl: field("agentUrl") ?? "",
				dockerHost: field("dockerHost") ?? "",
				name: field("name") ?? "",
				tlsCa: field("tlsCa"),
				tlsCert: field("tlsCert"),
				tlsKey: field("tlsKey"),
			});
		} catch (err) {
			if (err instanceof RemoteHostSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { success: true };
	},
};
