import { oauthMethod } from "#lib/auth-providers.js";
import { isSmtpEnabled } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { checkbox } from "#lib/server/validation/instance-settings-form.js";
import { PASSKEY_SIGN_IN, PASSWORD_SIGN_IN } from "#lib/sign-in-methods.js";

const PREFERRED_FIELD_PREFIX = "preferred:";

export const load = async ({ parent }) => {
	await parent();
	const settings = await InstanceSettingsDTO.get();
	return {
		emailSignIn: settings.emailSignIn,
		preferredSignInMethods: settings.preferredSignInMethods,
		securityPolicy: settings.securityPolicy,
		signInMethods: [
			{
				helperText: "Email and password form.",
				label: "Email and password",
				method: PASSWORD_SIGN_IN,
			},
			{
				helperText: "One-tap sign-in with a registered passkey.",
				label: "Passkey",
				method: PASSKEY_SIGN_IN,
			},
			...settings
				.toJSON()
				.oauthProviders.filter((p) => p.enabled)
				.map((p) => ({
					helperText: "OAuth / OIDC single sign-on.",
					label: p.label || p.name,
					method: oauthMethod(p.name),
				})),
		],
		smtpEnabled: isSmtpEnabled(),
	};
};

export const actions = {
	emailSignIn: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const settings = await InstanceSettingsDTO.get();
		await settings.updateEmailSignIn({
			emailOtp: checkbox(formData, "emailOtp"),
			magicLink: checkbox(formData, "magicLink"),
		});
		return { saved: true };
	},
	preferredSignIn: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const settings = await InstanceSettingsDTO.get();
		await settings.updatePreferredSignInMethods(
			[...formData.keys()]
				.filter((key) => key.startsWith(PREFERRED_FIELD_PREFIX))
				.filter((key) => formData.get(key) === "on")
				.map((key) => key.slice(PREFERRED_FIELD_PREFIX.length)),
		);
		return { saved: true };
	},
	securityPolicy: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const settings = await InstanceSettingsDTO.get();
		await settings.updateSecurityPolicy({
			requirePasskey: checkbox(formData, "requirePasskey"),
			requireTwoFactor: checkbox(formData, "requireTwoFactor"),
		});
		return { saved: true };
	},
};
