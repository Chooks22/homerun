import { fail, redirect } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { workstationAction } from "#lib/server/workstation-actions.js";
import { generateWorkstationPassword } from "#lib/server/workstation-form.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ params, parent }) => {
	const { user } = await parent();
	const ws = await WorkstationDTO.get(params.workstationId, user.id);
	return { password: ws?.password() ?? null };
};

export const actions = {
	resetPassword: async ({ locals, params }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		await ws.update({
			passwordEnc: encryptSecret(generateWorkstationPassword()),
		});
		logger.info(`Workstation password reset: workstation=${ws.id}`);
		return { ok: true };
	},
	start: ({ locals, params, request }) =>
		workstationAction(locals, request, "start", params.workstationId),
	stop: ({ locals, params, request }) =>
		workstationAction(locals, request, "stop", params.workstationId),
};
