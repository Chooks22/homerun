import { fail, redirect } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { saveWorkstationSection } from "#lib/server/workstation-actions.js";
import { presetFromWorkstation } from "#lib/server/workstation-presets.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ parent }) => {
	const { user } = await parent();
	return { gitProviders: await connectedGitProviders(user.id) };
};

export const actions = {
	container: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "container"),

	delete: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const formData = await request.formData();
		try {
			await WorkstationService.remove(ws, formData.get("volume") === "true");
		} catch (error) {
			logger.error(`Workstation delete failed: workstation=${ws.id}`, error);
			return fail(500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		redirect(303, resolve("workstations"));
	},

	editor: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "editor"),

	general: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const name = String((await request.formData()).get("name") ?? "").trim();
		if (!name) {
			return fail(400, { error: "Give the workstation a name." });
		}
		await ws.update({ name });
		logger.info(`Workstation renamed: workstation=${ws.id}`);
		return { ok: true };
	},

	git: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "git"),

	savePreset: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const formData = await request.formData();
		const name = String(formData.get("presetName") ?? "").trim();
		if (!name || name.length > 80) {
			return fail(400, {
				error: "Give the preset a name, up to 80 characters.",
			});
		}
		const description =
			String(formData.get("presetDescription") ?? "").trim() || null;
		const preset = await WorkstationPresetDTO.create(
			locals.user.id,
			presetFromWorkstation(ws.toPublic(), name, description),
		);
		logger.info(
			`Workstation saved as a preset: workstation=${ws.id} preset=${preset.id}`,
		);
		return { presetId: preset.id };
	},

	repository: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "repository"),
};
