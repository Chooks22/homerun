import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { workstationApiJson } from "#lib/server/infrastructure-api-json.js";
import {
	workstationApiBody,
	workstationColumns,
} from "#lib/server/validation/infrastructure-api.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const paged = await WorkstationDTO.listPaged(
		caller.userId,
		parseApiListQuery(url, ["state"]),
	);
	return jsonPage(
		paged.items.map((workstation) =>
			workstationApiJson(workstation.toPublic()),
		),
		paged,
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, workstationApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { autoStopMinutes, autoStopMode, desiredState, domain, name } =
		body.data;
	try {
		const workstation = await WorkstationSettingsService.create(
			caller.userId,
			{ ...workstationColumns(body.data), domain, name },
			{
				autoStop:
					autoStopMode === undefined
						? undefined
						: { minutes: autoStopMinutes ?? null, mode: autoStopMode },
				start: desiredState !== "stopped",
			},
		);
		return Response.json(workstationApiJson(workstation.toPublic()), {
			status: 201,
		});
	} catch (error) {
		if (error instanceof WorkstationSettingsError) {
			return apiError(error.message, error.status);
		}
		throw error;
	}
};
