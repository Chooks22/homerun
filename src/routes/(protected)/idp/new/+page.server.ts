import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import {
	mcpAllowed,
	mcpResource,
	oidcEndpointBase,
	oidcIssuer,
} from "#lib/oidc-provider.js";
import { parseOauthAppForm } from "#lib/server/oauth-app-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	OauthAppError,
	OauthAppService,
} from "#lib/services/oauth-app.service.js";

const logger = new Logger("OidcProvider");

export const load = () => {
	const origin = config.auth.origin;
	return {
		endpointBase: origin ? oidcEndpointBase(origin) : null,
		issuer: origin ? oidcIssuer(origin) : null,
		mcpUrl: origin && mcpAllowed(origin) ? mcpResource(origin) : null,
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!config.auth.origin) {
			return fail(400, {
				error:
					"Set the Dashboard URL under Settings → General first: it's the issuer apps sign in against.",
			});
		}

		const parsed = parseOauthAppForm(await request.formData());
		if (!parsed.input) {
			return fail(400, { error: parsed.error });
		}

		try {
			const created = await OauthAppService.create(parsed.input);
			logger.info(
				`OAuth app registered: client=${created.clientId} name=${parsed.input.name} user=${locals.user.id}`,
			);
			return { created: { ...created, name: parsed.input.name } };
		} catch (err) {
			if (err instanceof OauthAppError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
	},
};
