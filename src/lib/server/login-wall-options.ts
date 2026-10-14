import { oauthMethod } from "#lib/auth-providers.js";
import { config } from "#lib/config.js";
import type { LoginWallAvailability } from "#lib/server/login-wall-form.js";
import { emailSignInAvailability } from "#lib/services/email-sign-in.js";
import { UserService } from "#lib/services/user.service.js";

/** Which sign-in methods a login wall may use on this instance right now. */
export async function loginWallAvailability(): Promise<LoginWallAvailability> {
	return {
		email: await emailSignInAvailability(),
		oauthProviders: new Set(
			config.auth.oauthProviders.filter((p) => p.enabled).map((p) => p.name),
		),
	};
}

/**
 * Everything the login-wall section renders besides the policy itself: the
 * dashboard URL, the available methods and the accounts to pick from, none
 * when `withUsers` is false.
 */
export async function loginWallOptions(withUsers = true) {
	const [users, emailSignIn] = await Promise.all([
		withUsers ? UserService.listUsers() : [],
		emailSignInAvailability(),
	]);
	return {
		dashboardOrigin: config.auth.origin ?? null,
		emailSignIn,
		oauthProviders: config.auth.oauthProviders
			.filter((p) => p.enabled)
			.map((p) => ({
				label: p.label || p.name,
				method: oauthMethod(p.name),
				name: p.name,
			})),
		users: users.map((u) => ({
			email: u.email,
			id: u.id,
			name: u.name,
			role: u.role,
			type: u.type,
		})),
	};
}
