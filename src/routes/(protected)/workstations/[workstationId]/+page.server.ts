import { fail, redirect } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { workstationAction } from "#lib/server/workstation-actions.js";
import {
	generateWorkstationPassword,
	parseAutoStop,
} from "#lib/server/workstation-form.js";
import { encryptSecret } from "#lib/services/secrets.js";
import {
	isCodeServerImage,
	WorkstationSignInService,
} from "#lib/services/workstation/sign-in.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ params, parent }) => {
	const { user } = await parent();
	const ws = await WorkstationDTO.get(params.workstationId, user.id);
	const row = ws?.toPublic();
	const gate = row ? await WorkstationSignInService.gateFor(row) : null;
	return {
		gitSignIn: gate
			? {
					active: row?.signInWithGit ?? false,
					account: gate.providerUsername,
					provider: gate.provider.name,
				}
			: null,
		password: ws?.password() ?? null,
		passwordNeeded: !(
			gate &&
			row &&
			!row.remoteHostId &&
			isCodeServerImage(row.image)
		),
	};
};

export const actions = {
	autoStop: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
		if (!ws) {
			return fail(404, { error: "Workstation not found." });
		}
		const result = parseAutoStop(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		await WorkstationService.setAutoStop(
			ws,
			result.parsed.mode,
			result.parsed.minutes,
		);
		return { ok: true };
	},
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
