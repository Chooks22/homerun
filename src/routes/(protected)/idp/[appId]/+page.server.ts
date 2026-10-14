import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { Logger } from "#lib/logger.js";
import { adminApp } from "#lib/server/oauth-app-admin.js";
import { OauthAppService } from "#lib/services/oauth-app.service.js";
import {
	OAUTH_TEST_COOKIE,
	OauthTestService,
} from "#lib/services/oauth-test.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("OidcProvider");

export const actions = {
	toggle: async ({ locals, params }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const app = await OauthClientDTO.get(params.appId);
		if (!app) {
			return fail(404, { error: "That app isn't registered." });
		}
		const disabled = !app.summary().disabled;
		await OauthAppService.update(app, { disabled });
		logger.info(
			`OAuth app ${disabled ? "disabled" : "enabled"}: client=${app.clientId} user=${locals.user.id}`,
		);
		return { disabled };
	},

	test: async ({ cookies, locals, params, url }) => {
		const app = await adminApp(locals, params.appId);
		const origin = config.auth.origin;
		if (!origin) {
			return fail(400, {
				error: "Set the Dashboard URL under Settings → General first.",
			});
		}
		await OauthAppService.syncCallbacks(app);
		const { authorizeUrl, state } = await OauthTestService.start(app, origin);
		cookies.set(OAUTH_TEST_COOKIE, JSON.stringify(state), {
			httpOnly: true,
			maxAge: 600,
			path: "/idp",
			sameSite: "lax",
			secure: url.protocol === "https:",
		});
		logger.info(
			`OAuth app test sign-in started: client=${app.clientId} user=${locals.user?.id}`,
		);
		throw redirect(303, authorizeUrl, { external: true });
	},
};
