import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import { oidcAppSecretApiJson } from "#lib/server/identity-api-json.js";

/** The app and one of its environment secrets, null when either is missing or the secret is a test sign-in's. */
async function appSecret(appId: string, secretId: string) {
	const app = await OauthClientDTO.get(appId);
	const secret = app
		? await OauthClientSecretDTO.get(app.clientId, secretId)
		: null;
	return app && secret?.environmentId ? { app, secret } : null;
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await appSecret(params.appId, params.secretId);
	return found
		? Response.json(oidcAppSecretApiJson(found.app.id, found.secret.summary()))
		: apiError("Not found", 404);
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await appSecret(params.appId, params.secretId);
	if (!found) {
		return apiError("Not found", 404);
	}
	await found.secret.delete();
	return new Response(null, { status: 204 });
};
