import { error, fail, redirect } from "@sveltejs/kit";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { loginWallOptions } from "#lib/server/login-wall-options.js";
import { parseWorkstationPreset } from "#lib/server/workstation-form.js";
import { workstationHosts } from "#lib/server/workstation-presets.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { resolve } from "$app/paths";

const logger = new Logger("WorkstationPreset");

export const load = async ({ locals, params, parent }) => {
	const { user } = await parent();
	const [preset, hosts, gitProviders, wall] = await Promise.all([
		WorkstationPresetDTO.get(params.presetId, user.id),
		workstationHosts(),
		connectedGitProviders(user.id),
		loginWallOptions(can(locals.permissions, "services", "read")),
	]);
	if (!preset) {
		error(404, "Preset not found");
	}
	return {
		hosts,
		gitProviders,
		preset: preset.toJSON(),
		wall,
	};
};

export const actions = {
	delete: async ({ locals, params }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const preset = await WorkstationPresetDTO.get(
			params.presetId,
			locals.user.id,
		);
		if (!preset) {
			return fail(404, { error: "Preset not found." });
		}
		await preset.delete();
		logger.info(`Workstation preset deleted: preset=${preset.id}`);
		redirect(303, resolve("workstations/presets"));
	},

	save: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const preset = await WorkstationPresetDTO.get(
			params.presetId,
			locals.user.id,
		);
		if (!preset) {
			return fail(404, { error: "Preset not found." });
		}
		const result = parseWorkstationPreset(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		try {
			await WorkstationSettingsService.updatePreset(preset, result.parsed);
		} catch (err) {
			if (err instanceof WorkstationSettingsError) {
				return fail(err.status, { error: err.message });
			}
			throw err;
		}
		return { ok: true };
	},
};
