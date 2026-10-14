import { fail, redirect } from "@sveltejs/kit";
import { APP_VERSION } from "#lib/server/app-version.js";
import { agentSetupCommands } from "#lib/server/node-install-script.js";
import {
	RemoteHostSettingsError,
	RemoteHostSettingsService,
} from "#lib/services/remote-host-settings.service.js";
import { resolve } from "$app/paths";

export const load = () => ({
	agentCommands: agentSetupCommands(APP_VERSION),
});

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const field = (key: string) => formData.get(key) as string | null;
		try {
			const host = await RemoteHostSettingsService.create(
				{
					agentToken: field("agentToken"),
					agentUrl: field("agentUrl"),
					dockerHost: field("dockerHost"),
					kind: field("kind") === "agent" ? "agent" : "docker",
					name: field("name"),
					tlsCa: field("tlsCa"),
					tlsCert: field("tlsCert"),
					tlsKey: field("tlsKey"),
				},
				locals.user.id,
			);
			return { hostId: host.id, success: true };
		} catch (error) {
			if (error instanceof RemoteHostSettingsError) {
				return fail(400, { error: error.message });
			}
			throw error;
		}
	},
};
