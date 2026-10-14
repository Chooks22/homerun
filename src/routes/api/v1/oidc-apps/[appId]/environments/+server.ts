import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { OauthClientEnvironmentDTO } from "#lib/dto/oauth-client-environment-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oidcAppEnvironmentApiJson } from "#lib/server/identity-api-json.js";
import { createOidcAppEnvironmentApiBody } from "#lib/server/validation/identity-api.js";
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
	if (!app) {
		return apiError("Not found", 404);
	}
	const environments = await OauthClientEnvironmentDTO.listForClient(
		app.clientId,
	);
	return Response.json(
		environments.map((environment) =>
			oidcAppEnvironmentApiJson(app.id, environment),
		),
	);
};

export const POST = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const app = await OauthClientDTO.get(params.appId);
	if (!app) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, createOidcAppEnvironmentApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const environment = await OauthAppService.addEnvironment(app, body.data);
		return Response.json(oidcAppEnvironmentApiJson(app.id, environment), {
			status: 201,
		});
	} catch (err) {
		if (err instanceof OauthAppError) {
			return apiError(err.message);
		}
		throw err;
	}
};
