import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { can } from "#lib/permissions.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { loginWallOptions } from "#lib/server/login-wall-options.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { parseNewWorkstation } from "#lib/server/workstation-form.js";
import { workstationHosts } from "#lib/server/workstation-presets.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { resolve } from "$app/paths";

export const load = async ({ locals, parent, url }) => {
	const { user } = await parent();
	const [hosts, gitProviders, presets, wall] = await Promise.all([
		workstationHosts(),
		connectedGitProviders(user.id),
		WorkstationPresetDTO.listForUser(user.id),
		loginWallOptions(can(locals.permissions, "services", "read")),
	]);
	const presetId = url.searchParams.get("preset");
	return {
		hosts,
		baseDomain: config.baseDomain,
		gitProviders,
		preset: presets.find((p) => p.id === presetId)?.toJSON() ?? null,
		presets: presets.map((p) => ({
			description: p.toJSON().description,
			id: p.id,
			name: p.name,
		})),
		wall,
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const result = parseNewWorkstation(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		let workstationId: string;
		try {
			workstationId = (
				await WorkstationSettingsService.create(locals.user.id, result.parsed)
			).id;
		} catch (error) {
			if (error instanceof WorkstationSettingsError) {
				return fail(error.status, { error: error.message });
			}
			throw error;
		}
		redirect(
			303,
			resolve("/(protected)/workstations/[workstationId]", {
				workstationId,
			}),
		);
	},
};
