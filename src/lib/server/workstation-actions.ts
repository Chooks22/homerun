import { fail } from "@sveltejs/kit";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	parseWorkstationSection,
	type WorkstationSection,
	type WorkstationSettings,
} from "#lib/server/workstation-form.js";
import { WorkstationService } from "#lib/services/workstation.service.js";

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
		redirectToSignIn();
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

/**
 * Saves Settings sections of the signed-in user's workstation `id` from one
 * form: only those sections' columns are validated and written, so each
 * section's form saves on its own, and the dev container Apply saves the
 * Editor and Container sections together.
 *
 * @returns `{ ok: true }`, or a 400/404 failure carrying the first message;
 *   nothing is written when any section is invalid.
 * @throws A redirect to sign-in when nobody is signed in.
 */
export async function saveWorkstationSection(
	locals: App.Locals,
	request: Request,
	id: string,
	...sections: WorkstationSection[]
) {
	if (!locals.user) {
		redirectToSignIn();
	}
	const ws = await WorkstationDTO.get(id, locals.user.id);
	if (!ws) {
		return fail(404, { error: "Workstation not found." });
	}
	const formData = await request.formData();
	const parsed: Partial<WorkstationSettings> = {};
	for (const section of sections) {
		const result = parseWorkstationSection(section, formData);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		Object.assign(parsed, result.parsed);
	}
	await ws.update(parsed);
	logger.info(
		`Workstation settings saved: workstation=${ws.id} section=${sections.join(",")}`,
	);
	return { ok: true };
}
