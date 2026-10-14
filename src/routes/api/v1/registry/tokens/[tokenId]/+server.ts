import { apiCaller, apiError } from "#lib/server/api-route.js";
import { RegistryService } from "#lib/services/registry.service.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const token = await SettingsApiService.registryToken(params.tokenId);
	return token ? Response.json(token) : apiError("Not found", 404);
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	if (!(await SettingsApiService.registryToken(params.tokenId))) {
		return apiError("Not found", 404);
	}
	await RegistryService.revokeToken(params.tokenId);
	return new Response(null, { status: 204 });
};
