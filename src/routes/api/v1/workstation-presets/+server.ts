import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { workstationPresetApiJson } from "#lib/server/infrastructure-api-json.js";
import {
	workstationColumns,
	workstationPresetApiBody,
} from "#lib/server/validation/infrastructure-api.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const presets = await WorkstationPresetDTO.listForUser(caller.userId);
	return Response.json(
		presets.map((preset) => workstationPresetApiJson(preset.toJSON())),
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, workstationPresetApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const preset = await WorkstationSettingsService.createPreset(
			caller.userId,
			{
				...workstationColumns(body.data),
				description: body.data.description?.trim() || null,
				name: body.data.name,
			},
		);
		return Response.json(workstationPresetApiJson(preset.toJSON()), {
			status: 201,
		});
	} catch (error) {
		if (error instanceof WorkstationSettingsError) {
			return apiError(error.message, error.status);
		}
		throw error;
	}
};
