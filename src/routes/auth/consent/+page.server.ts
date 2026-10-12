import { error, redirect } from "@sveltejs/kit";
import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { describeScopes } from "#lib/oidc-provider.js";
import { resolve } from "$app/paths";

export const load = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(302, `${resolve("auth/sign-in")}${url.search}`);
	}
	const clientId = url.searchParams.get("client_id");
	const app = clientId ? await OauthClientDTO.getByClientId(clientId) : null;
	if (!app) {
		error(400, "This sign-in request doesn't name an app Homerun knows.");
	}
	return {
		appName: app.name,
		discoveredFrom: clientId?.startsWith("https://")
			? new URL(clientId).host
			: null,
		scopes: describeScopes(url.searchParams.get("scope")),
		signedInAs: locals.user.email,
	};
};
