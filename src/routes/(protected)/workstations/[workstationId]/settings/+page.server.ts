import { fail, redirect } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { parseWorkstationSettings } from "#lib/server/workstation-form.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ parent }) => {
	const { user } = await parent();
	return { gitProviders: await connectedGitProviders(user.id) };
};

export const actions = {
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

	save: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const formData = await request.formData();
		const result = parseWorkstationSettings(formData);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		const name = String(formData.get("name") ?? "").trim();
		if (!name) {
			return fail(400, { error: "Give the workstation a name." });
		}
		await ws.update({ ...result.parsed, name });
		logger.info(`Workstation settings saved: workstation=${ws.id}`);
		return { ok: true };
	},
};
