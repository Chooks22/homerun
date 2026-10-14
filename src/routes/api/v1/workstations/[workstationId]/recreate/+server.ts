import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import { workstationApiJson } from "#lib/server/infrastructure-api-json.js";
import { WorkstationService } from "#lib/services/workstation.service.js";

const logger = new Logger("Workstation");

export const POST = async ({ locals, params }) => {
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
		await WorkstationService.start(workstation);
	} catch (error) {
		logger.error(
			`Workstation recreate failed: workstation=${workstation.id}`,
			error,
		);
		return apiError(
			error instanceof Error ? error.message : String(error),
			502,
		);
	}
	logger.info(
		`Workstation recreated via API: workstation=${workstation.id} user=${caller.userId}`,
	);
	return Response.json(workstationApiJson(workstation.toPublic()));
};
