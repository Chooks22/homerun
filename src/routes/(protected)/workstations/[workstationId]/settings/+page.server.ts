import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { parseLoginWallForm } from "#lib/server/login-wall-form.js";
import {
	loginWallAvailability,
	loginWallOptions,
} from "#lib/server/login-wall-options.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { saveWorkstationSection } from "#lib/server/workstation-actions.js";
import { presetFromWorkstation } from "#lib/server/workstation-presets.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ locals, parent }) => {
	const { user } = await parent();
	const [gitProviders, wall] = await Promise.all([
		connectedGitProviders(user.id),
		loginWallOptions(can(locals.permissions, "services", "read")),
	]);
	return {
		gitProviders,
		wall,
	};
};

export const actions = {
	container: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "container"),

	delete: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
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

	devcontainer: ({ locals, params, request }) =>
		saveWorkstationSection(
			locals,
			request,
			params.workstationId,
			"editor",
			"container",
		),

	editor: ({ locals, params, request }) =>
		saveWorkstationSection(locals, request, params.workstationId, "editor"),

	general: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
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

	loginWall: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const parsed = parseLoginWallForm(
			await request.formData(),
			await loginWallAvailability(),
			config.auth.origin,
		);
		if ("error" in parsed) {
			return fail(400, { authError: parsed.error });
		}
		try {
			const { restarted } = await WorkstationSettingsService.update(
				ws,
				parsed.policy,
			);
			logger.info(
				`Workstation login wall saved: workstation=${ws.id} authRequired=${parsed.policy.authRequired} methods=${parsed.policy.authProviders.join("|") || "none"}`,
			);
			return { authSuccess: true, redeploying: restarted };
		} catch (error) {
			if (error instanceof WorkstationSettingsError) {
				return fail(error.status, { authError: error.message });
			}
			logger.error(
				`Workstation restart for its login wall failed: workstation=${ws.id}`,
				error,
			);
			return fail(502, {
				authError: `Saved, but the restart failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	},

	savePreset: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
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
