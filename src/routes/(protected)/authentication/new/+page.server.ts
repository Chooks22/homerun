import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { readOauthProviderForm } from "#lib/server/oauth-provider-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	OauthProviderConfigError,
	OauthProviderConfigService,
} from "#lib/services/oauth-provider-config.service.js";
import { resolve } from "$app/paths";

export const load = () => {
	return { callbackBase: config.auth.origin ?? null };
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		let name: string;
		try {
			const provider = await OauthProviderConfigService.add(
				readOauthProviderForm(formData),
				locals.user.id,
			);
			name = provider.name;
		} catch (err) {
			if (err instanceof OauthProviderConfigError) {
				return fail(400, {
					error: err.message,
					values: Object.fromEntries(formData),
				});
			}
			throw err;
		}

		throw redirect(
			303,
			`${resolve("authentication")}/${encodeURIComponent(name)}`,
		);
	},
};
