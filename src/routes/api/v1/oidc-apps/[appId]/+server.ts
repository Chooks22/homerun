import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oidcAppApiJson } from "#lib/server/identity-api-json.js";
import { updateOidcAppApiBody } from "#lib/server/validation/identity-api.js";
import {
	OauthAppError,
	OauthAppService,
} from "#lib/services/oauth-app.service.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	return app ? Response.json(oidcAppApiJson(app)) : apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	if (!app) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateOidcAppApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { tokenAuthMethod, ...changes } = body.data;
	try {
		await OauthAppService.update(app, {
			...changes,
			tokenEndpointAuthMethod: tokenAuthMethod,
		});
	} catch (err) {
		if (err instanceof OauthAppError) {
			return apiError(err.message);
		}
		throw err;
	}
	return Response.json(oidcAppApiJson(app));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	if (!app) {
		return apiError("Not found", 404);
	}
	await app.delete();
	return new Response(null, { status: 204 });
};
