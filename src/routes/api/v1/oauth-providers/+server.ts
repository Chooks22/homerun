import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oauthProviderApiJson } from "#lib/server/identity-api-json.js";
import { createOauthProviderApiBody } from "#lib/server/validation/identity-api.js";
import {
	OauthProviderConfigError,
	OauthProviderConfigService,
} from "#lib/services/oauth-provider-config.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(
		(await OauthProviderConfigService.list()).map(oauthProviderApiJson),
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, createOauthProviderApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const provider = await OauthProviderConfigService.add(
			{ ...body.data, label: body.data.label ?? "" },
			caller.userId,
		);
		return Response.json(oauthProviderApiJson(provider), { status: 201 });
	} catch (err) {
		if (err instanceof OauthProviderConfigError) {
			return apiError(err.message);
		}
		throw err;
	}
};
