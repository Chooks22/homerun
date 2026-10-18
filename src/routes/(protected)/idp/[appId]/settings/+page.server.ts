import { fail, redirect } from "@sveltejs/kit";
import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { Logger } from "#lib/logger.js";
import { parseOauthAppSettings } from "#lib/server/oauth-app-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	OauthAppError,
	OauthAppService,
} from "#lib/services/oauth-app.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("OidcProvider");

export const actions = {
	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const app = await OauthClientDTO.get(params.appId);
		if (!app) {
			return fail(404, { error: "That app isn't registered." });
		}
		const parsed = parseOauthAppSettings(await request.formData());
		if (!parsed.input) {
			return fail(400, { error: parsed.error });
		}
		const confidential = app.summary().confidential;
		try {
			await OauthAppService.update(app, {
				enableEndSession: parsed.input.enableEndSession,
				name: parsed.input.name,
				requirePkce: confidential ? parsed.input.requirePkce : undefined,
				skipConsent: parsed.input.skipConsent,
				tokenEndpointAuthMethod: confidential
					? parsed.input.tokenAuthMethod
					: undefined,
			});
		} catch (err) {
			if (err instanceof OauthAppError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`OAuth app updated: client=${app.clientId} user=${locals.user.id}`,
		);
		return { saved: true };
	},

	delete: async ({ locals, params }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const app = await OauthClientDTO.get(params.appId);
		if (app) {
			await app.delete();
			logger.info(
				`OAuth app deleted: client=${app.clientId} user=${locals.user.id}`,
			);
		}
		throw redirect(303, resolve("idp"));
	},
};
