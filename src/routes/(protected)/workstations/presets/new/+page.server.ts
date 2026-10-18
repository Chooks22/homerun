import { fail, redirect } from "@sveltejs/kit";
import { can } from "#lib/permissions.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { loginWallOptions } from "#lib/server/login-wall-options.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { parseWorkstationPreset } from "#lib/server/workstation-form.js";
import { workstationHosts } from "#lib/server/workstation-presets.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { resolve } from "$app/paths";

export const load = async ({ locals, parent }) => {
	const { user } = await parent();
	const [hosts, gitProviders, wall] = await Promise.all([
		workstationHosts(),
		connectedGitProviders(user.id),
		loginWallOptions(can(locals.permissions, "services", "read")),
	]);
	return {
		hosts,
		gitProviders,
		wall,
	};
};

export const actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const result = parseWorkstationPreset(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		let presetId: string;
		try {
			presetId = (
				await WorkstationSettingsService.createPreset(
					locals.user.id,
					result.parsed,
				)
			).id;
		} catch (error) {
			if (error instanceof WorkstationSettingsError) {
				return fail(error.status, { error: error.message });
			}
			throw error;
		}
		redirect(
			303,
			resolve("/(protected)/workstations/presets/[presetId]", {
				presetId,
			}),
		);
	},
};
