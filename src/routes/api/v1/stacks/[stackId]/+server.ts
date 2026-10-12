import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { updateStackApiBody } from "#lib/server/validation/api.js";
import { WorkloadDetachError } from "#lib/services/docker/workload-removal.js";
import {
	ServiceLifecycleService,
	StackBusyError,
} from "#lib/services/service-lifecycle.service.js";
import {
	StackSettingsError,
	StackSettingsService,
} from "#lib/services/stack-settings.service.js";

const logger = new Logger("API");

export const GET = async ({ params, locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const stack = await StackDTO.get(params.stackId);
	return stack ? Response.json(stack.toJSON()) : apiError("Not found", 404);
};

export const PATCH = async ({ params, request, locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const stack = await StackDTO.get(params.stackId);
	if (!stack) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateStackApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		await StackSettingsService.apply(stack, body.data);
	} catch (err) {
		if (err instanceof StackSettingsError) {
			return apiError(err.message);
		}
		throw err;
	}
	return Response.json(stack.toJSON());
};

export const DELETE = async ({ params, locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const stack = await StackDTO.get(params.stackId);
	if (!stack) {
		return apiError("Not found", 404);
	}
	const force = url.searchParams.get("force") === "true";
	const deleteVolumes = url.searchParams.get("deleteVolumes") === "true";
	try {
		await ServiceLifecycleService.deleteStack(stack, { deleteVolumes, force });
	} catch (err) {
		if (err instanceof WorkloadDetachError || err instanceof StackBusyError) {
			return apiError(err.message, 409);
		}
		throw err;
	}
	logger.info(
		`Stack deleted via API: stack=${params.stackId} force=${force} deleteVolumes=${deleteVolumes} user=${caller.userId}`,
	);
	return new Response(null, { status: 204 });
};
