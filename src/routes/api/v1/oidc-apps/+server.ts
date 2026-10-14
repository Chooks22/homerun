import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { apiCaller, readApiBody } from "#lib/server/api-route.js";
import { oidcAppApiJson } from "#lib/server/identity-api-json.js";
import { createOidcAppApiBody } from "#lib/server/validation/identity-api.js";
import { OauthAppService } from "#lib/services/oauth-app.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json((await OauthClientDTO.list()).map(oidcAppApiJson));
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, createOidcAppApiBody);
	if ("response" in body) {
		return body.response;
	}
	const app = await OauthAppService.register({
		...body.data,
		requirePkce: body.data.requirePkce ?? true,
		tokenAuthMethod: body.data.tokenAuthMethod ?? "client_secret_basic",
	});
	return Response.json(oidcAppApiJson(app), { status: 201 });
};
