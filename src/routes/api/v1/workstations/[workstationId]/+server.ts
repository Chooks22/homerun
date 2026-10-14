import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { workstationApiJson } from "#lib/server/infrastructure-api-json.js";
import {
	updateWorkstationApiBody,
	workstationColumns,
	workstationWallColumns,
} from "#lib/server/validation/infrastructure-api.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { WorkstationService } from "#lib/services/workstation.service.js";

const logger = new Logger("Workstation");

/** A thrown worker or agent error as a message. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const workstation = await WorkstationDTO.get(
		params.workstationId,
		caller.userId,
	);
	return workstation
		? Response.json(workstationApiJson(workstation.toPublic()))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const workstation = await WorkstationDTO.get(
		params.workstationId,
		caller.userId,
	);
	if (!workstation) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateWorkstationApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { autoStopMinutes, autoStopMode, desiredState, name } = body.data;
	const minutes =
		autoStopMinutes === undefined
			? workstation.toJSON().autoStopMinutes
			: autoStopMinutes;
	try {
		await WorkstationSettingsService.update(workstation, {
			...workstationColumns(body.data),
			...workstationWallColumns(body.data),
			...(name === undefined ? {} : { name }),
			autoStop:
				autoStopMode === undefined && autoStopMinutes === undefined
					? undefined
					: {
							minutes,
							mode:
								autoStopMode === undefined
									? workstation.toJSON().autoStopMode
									: autoStopMode,
						},
			desiredState,
		});
	} catch (error) {
		if (error instanceof WorkstationSettingsError) {
			return apiError(error.message, error.status);
		}
		logger.error(
			`Workstation ${desiredState === "stopped" ? "stop" : "start"} failed: workstation=${workstation.id}`,
			error,
		);
		return apiError(message(error), 502);
	}
	return Response.json(workstationApiJson(workstation.toPublic()));
};

export const DELETE = async ({ locals, params, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const workstation = await WorkstationDTO.get(
		params.workstationId,
		caller.userId,
	);
	if (!workstation) {
		return apiError("Not found", 404);
	}
	try {
		await WorkstationService.remove(
			workstation,
			url.searchParams.get("volume") === "true",
		);
	} catch (error) {
		logger.error(
			`Workstation delete failed: workstation=${workstation.id}`,
			error,
		);
		return apiError(message(error), 502);
	}
	return new Response(null, { status: 204 });
};
