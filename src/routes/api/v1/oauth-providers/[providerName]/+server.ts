import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oauthProviderApiJson } from "#lib/server/identity-api-json.js";
import { updateOauthProviderApiBody } from "#lib/server/validation/identity-api.js";
import {
	OauthProviderConfigError,
	OauthProviderConfigService,
} from "#lib/services/oauth-provider-config.service.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const provider = await OauthProviderConfigService.get(params.providerName);
	return provider
		? Response.json(oauthProviderApiJson(provider))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	if (!(await OauthProviderConfigService.get(params.providerName))) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateOauthProviderApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const provider = await OauthProviderConfigService.update(
			params.providerName,
			body.data,
			caller.userId,
		);
		return Response.json(oauthProviderApiJson(provider));
	} catch (err) {
		if (err instanceof OauthProviderConfigError) {
			return apiError(err.message);
		}
		throw err;
	}
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	if (!(await OauthProviderConfigService.get(params.providerName))) {
		return apiError("Not found", 404);
	}
	await OauthProviderConfigService.remove(params.providerName, caller.userId);
	return new Response(null, { status: 204 });
};
