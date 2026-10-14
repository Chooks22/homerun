import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { remoteHostApiJson } from "#lib/server/infrastructure-api-json.js";
import { remoteHostApiBody } from "#lib/server/validation/infrastructure-api.js";
import {
	RemoteHostSettingsError,
	RemoteHostSettingsService,
} from "#lib/services/remote-host-settings.service.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const paged = await RemoteHostDTO.listPaged(parseApiListQuery(url, ["kind"]));
	return jsonPage(
		paged.items.map((host) => remoteHostApiJson(host.toJSON())),
		paged,
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, remoteHostApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const host = await RemoteHostSettingsService.create(
			body.data,
			caller.userId,
		);
		return Response.json(remoteHostApiJson(host.toJSON()), { status: 201 });
	} catch (error) {
		if (error instanceof RemoteHostSettingsError) {
			return apiError(error.message);
		}
		throw error;
	}
};
