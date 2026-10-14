import { parsePermissions } from "#lib/permissions.js";
import type { InstanceOauthProvider, User } from "#lib/server/db/schema.js";

/**
 * A user as the REST API returns it: its own permissions only for the
 * custom role (`{}` otherwise, the role's preset decides), no ban or 2FA
 * internals.
 */
export function userApiJson(user: User) {
	const role = user.role ?? "developer";
	return {
		createdAt: user.createdAt,
		email: user.email,
		emailVerified: user.emailVerified,
		id: user.id,
		lastSignInAt: user.lastSignInAt,
		name: user.name,
		permissions: role === "custom" ? parsePermissions(user.permissions) : {},
		role,
		updatedAt: user.updatedAt,
	};
}

/**
 * An OAuth sign-in provider as the REST API returns it: its name doubles as
 * its id, and the client secret is reduced to whether one is stored.
 */
export function oauthProviderApiJson(provider: InstanceOauthProvider) {
	return {
		clientId: provider.clientId,
		clientSecretSet: Boolean(provider.clientSecretEnc),
		discoveryUrl: provider.discoveryUrl,
		enabled: provider.enabled,
		id: provider.name,
		label: provider.label || provider.name,
		name: provider.name,
		pkce: provider.pkce,
		scopes: provider.scopes,
		signOutOfProvider: provider.signOutOfProvider ?? false,
		tokenAuthMethod: provider.tokenAuthMethod ?? "auto",
	};
}
