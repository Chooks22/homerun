import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { workstationPresetApiJson } from "#lib/server/infrastructure-api-json.js";
import {
	updateWorkstationPresetApiBody,
	workstationColumns,
	workstationWallColumns,
} from "#lib/server/validation/infrastructure-api.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";

const logger = new Logger("WorkstationPreset");

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const preset = await WorkstationPresetDTO.get(params.presetId, caller.userId);
	return preset
		? Response.json(workstationPresetApiJson(preset.toJSON()))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const preset = await WorkstationPresetDTO.get(params.presetId, caller.userId);
	if (!preset) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateWorkstationPresetApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { description, name } = body.data;
	try {
		await WorkstationSettingsService.updatePreset(preset, {
			...workstationColumns(body.data),
			...workstationWallColumns(body.data),
			...(description === undefined
				? {}
				: { description: description?.trim() || null }),
			...(name === undefined ? {} : { name }),
		});
	} catch (error) {
		if (error instanceof WorkstationSettingsError) {
			return apiError(error.message, error.status);
		}
		throw error;
	}
	return Response.json(workstationPresetApiJson(preset.toJSON()));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const preset = await WorkstationPresetDTO.get(params.presetId, caller.userId);
	if (!preset) {
		return apiError("Not found", 404);
	}
	await preset.delete();
	logger.info(`Workstation preset deleted: preset=${preset.id}`);
	return new Response(null, { status: 204 });
};
