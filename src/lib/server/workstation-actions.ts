import { fail, redirect } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

/**
 * Runs `operation` on the signed-in user's workstation named by the form's
 * `workstationId` (or `id` when the route already knows it), for a start or
 * stop form action.
 *
 * @returns The action's answer: `{ ok: true }`, or a 404/500 failure
 *   carrying the message.
 * @throws A redirect to sign-in when nobody is signed in.
 */
export async function workstationAction(
	locals: App.Locals,
	request: Request,
	operation: "start" | "stop",
	id?: string,
) {
	if (!locals.user) {
		throw redirect(302, resolve("auth/sign-in"));
	}
	const formData = await request.formData();
	const workstationId = id ?? String(formData.get("workstationId") ?? "");
	const ws = await WorkstationDTO.get(workstationId, locals.user.id);
	if (!ws) {
		return fail(404, { error: "Workstation not found." });
	}
	try {
		if (operation === "start") {
			await WorkstationService.start(ws);
		} else {
			await WorkstationService.stop(ws);
		}
	} catch (error) {
		logger.error(
			`Workstation ${operation} failed: workstation=${ws.id}`,
			error,
		);
		return fail(500, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return { ok: true };
}
