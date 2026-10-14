import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { OauthClientEnvironmentDTO } from "#lib/dto/oauth-client-environment-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oidcAppEnvironmentApiJson } from "#lib/server/identity-api-json.js";
import { updateOidcAppEnvironmentApiBody } from "#lib/server/validation/identity-api.js";
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
	const environment = app
		? await OauthClientEnvironmentDTO.get(app.clientId, params.environmentId)
		: null;
	return app && environment
		? Response.json(oidcAppEnvironmentApiJson(app.id, environment))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	const environment = app
		? await OauthClientEnvironmentDTO.get(app.clientId, params.environmentId)
		: null;
	if (!(app && environment)) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateOidcAppEnvironmentApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		await OauthAppService.updateEnvironment(app, environment, {
			allowedOrigins: body.data.allowedOrigins ?? environment.allowedOrigins,
			allowLocalhost: body.data.allowLocalhost ?? environment.allowLocalhost,
			name: body.data.name ?? environment.name,
			redirectUris: body.data.redirectUris ?? environment.redirectUris,
		});
	} catch (err) {
		if (err instanceof OauthAppError) {
			return apiError(err.message);
		}
		throw err;
	}
	return Response.json(oidcAppEnvironmentApiJson(app.id, environment));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	const environment = app
		? await OauthClientEnvironmentDTO.get(app.clientId, params.environmentId)
		: null;
	if (!(app && environment)) {
		return apiError("Not found", 404);
	}
	await OauthAppService.deleteEnvironment(app, environment);
	return new Response(null, { status: 204 });
};
