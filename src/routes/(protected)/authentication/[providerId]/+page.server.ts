import { error, fail, redirect } from "@sveltejs/kit";
import { oauthMethod } from "#lib/auth-providers.js";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { readOauthProviderForm } from "#lib/server/oauth-provider-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	OauthProviderConfigError,
	OauthProviderConfigService,
} from "#lib/services/oauth-provider-config.service.js";
import { resolve } from "$app/paths";

export const load = async ({ params, parent }) => {
	await parent();
	const settings = await InstanceSettingsDTO.get();
	const provider = settings
		.toJSON()
		.oauthProviders.find((p) => p.name === params.providerId);
	if (!provider) {
		error(404, "No OAuth provider with that id.");
	}

	const services = await ServiceDTO.list();
	const method = oauthMethod(provider.name);

	return {
		callbackBase: config.auth.origin ?? null,
		provider: {
			clientId: provider.clientId,
			discoveryUrl: provider.discoveryUrl,
			enabled: provider.enabled,
			hasSecret: !!provider.clientSecretEnc,
			label: provider.label || provider.name,
			name: provider.name,
			pkce: provider.pkce,
			scopes: provider.scopes.join(", "),
			signOutOfProvider: provider.signOutOfProvider ?? false,
			tokenAuthMethod: provider.tokenAuthMethod ?? "auto",
		},
		usedBy: services
			.filter((svc) => svc.authRequired && svc.authProviders.includes(method))
			.map((svc) => ({ id: svc.id, name: svc.name })),
	};
};

export const actions = {
	delete: async ({ locals, params }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		await OauthProviderConfigService.remove(params.providerId, locals.user.id);

		throw redirect(303, resolve("authentication/providers"));
	},
	update: async ({ request, locals, params }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		try {
			await OauthProviderConfigService.update(
				params.providerId,
				readOauthProviderForm(await request.formData()),
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof OauthProviderConfigError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { success: true };
	},
};
