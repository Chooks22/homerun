import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { registryTokenApiBody } from "#lib/server/validation/settings-api.js";
import { InstanceSettingsError } from "#lib/services/instance-settings.service.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(await SettingsApiService.registryTokens());
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, registryTokenApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		return Response.json(
			await SettingsApiService.createRegistryToken(
				body.data.username,
				caller.userId,
			),
			{ status: 201 },
		);
	} catch (err) {
		if (err instanceof InstanceSettingsError) {
			return apiError(err.message);
		}
		throw err;
	}
};
