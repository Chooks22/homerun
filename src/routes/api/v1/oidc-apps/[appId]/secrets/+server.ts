import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { oidcAppSecretApiJson } from "#lib/server/identity-api-json.js";
import { createOidcAppSecretApiBody } from "#lib/server/validation/identity-api.js";
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
	const secrets = await OauthClientSecretDTO.listForClient(app.clientId);
	return Response.json(
		secrets
			.map((secret) => secret.summary())
			.filter((secret) => secret.environmentId !== null)
			.map((secret) => oidcAppSecretApiJson(app.id, secret)),
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
	const body = await readApiBody(request, createOidcAppSecretApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const { row, secret } = await OauthAppService.issueSecret(
			app,
			body.data.environmentId,
			body.data.label ?? "",
		);
		return Response.json(
			{ ...oidcAppSecretApiJson(app.id, row.summary()), secret },
			{ status: 201 },
		);
	} catch (err) {
		if (err instanceof OauthAppError) {
			return apiError(err.message);
		}
		throw err;
	}
};
