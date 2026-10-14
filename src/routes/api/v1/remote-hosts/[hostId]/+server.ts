import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { remoteHostApiJson } from "#lib/server/infrastructure-api-json.js";
import { updateRemoteHostApiBody } from "#lib/server/validation/infrastructure-api.js";
import {
	RemoteHostSettingsError,
	RemoteHostSettingsService,
} from "#lib/services/remote-host-settings.service.js";

const logger = new Logger("RemoteHosts");

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const host = await RemoteHostDTO.get(params.hostId);
	return host
		? Response.json(remoteHostApiJson(host.toJSON()))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const host = await RemoteHostDTO.get(params.hostId);
	if (!host) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateRemoteHostApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		await RemoteHostSettingsService.update(host, body.data);
	} catch (error) {
		if (error instanceof RemoteHostSettingsError) {
			return apiError(error.message);
		}
		throw error;
	}
	return Response.json(remoteHostApiJson(host.toJSON()));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const host = await RemoteHostDTO.get(params.hostId);
	if (!host) {
		return apiError("Not found", 404);
	}
	await RemoteHostSettingsService.remove(host);
	logger.info(`Remote host deleted: host=${host.id} user=${caller.userId}`);
	return new Response(null, { status: 204 });
};
