import { redirect } from "@sveltejs/kit";
import { isSmtpEnabled } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { APP_ONLY_HOME } from "#lib/permissions.js";
import { setPasswordActions } from "#lib/server/set-password-actions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { AccountSecurityService } from "#lib/services/account-security.service.js";
import { AppAccessService } from "#lib/services/app-access.service.js";
import { resolve } from "$app/paths";

export const load = async ({ locals }) => {
	if (!locals.user) {
		redirectToSignIn();
	}
	if (!locals.appOnly) {
		throw redirect(302, resolve(""));
	}

	const userId = locals.user.id;
	if (locals.session) {
		const settings = await InstanceSettingsDTO.get();
		const unmet = await AccountSecurityService.unmetRequirements(
			userId,
			settings.securityPolicy,
		);
		if (unmet.length > 0) {
			throw redirect(
				302,
				`${resolve("security-setup")}?next=${encodeURIComponent(APP_ONLY_HOME)}`,
			);
		}
	}

	const [apps, hasPassword, passkeys, security] = await Promise.all([
		AppAccessService.sharedApps(userId),
		AccountSecurityService.hasPassword(userId),
		AccountSecurityService.listPasskeys(userId),
		AccountSecurityService.state(userId),
	]);

	return {
		apps,
		email: locals.user.email,
		hasPassword,
		passkeys,
		smtpEnabled: isSmtpEnabled(),
		twoFactorEnabled: security.twoFactorEnabled,
	};
};

export const actions = setPasswordActions;
