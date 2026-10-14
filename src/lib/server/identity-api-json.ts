import { config } from "#lib/config.js";
import type { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import type { OauthClientEnvironmentDTO } from "#lib/dto/oauth-client-environment-dto.js";
import type { OauthClientSecretSummary } from "#lib/dto/oauth-client-secret-dto.js";
import { oidcDiscoveryUrl } from "#lib/oidc-provider.js";
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

/**
 * A "Sign in with Homerun" app as the REST API returns it: its token auth
 * method only when it's confidential, and the discovery document to point
 * it at once the Dashboard URL is set.
 */
export function oidcAppApiJson(app: OauthClientDTO) {
	const summary = app.summary();
	return {
		clientId: summary.clientId,
		confidential: summary.confidential,
		createdAt: summary.createdAt,
		disabled: summary.disabled,
		discoveryUrl: config.auth.origin
			? oidcDiscoveryUrl(config.auth.origin)
			: null,
		enableEndSession: summary.enableEndSession,
		id: summary.id,
		name: summary.name,
		requirePkce: summary.requirePkce,
		skipConsent: summary.skipConsent,
		tokenAuthMethod: summary.confidential ? summary.tokenAuthMethod : null,
	};
}

/** One environment of an app as the REST API returns it, with the app's id. */
export function oidcAppEnvironmentApiJson(
	appId: string,
	environment: OauthClientEnvironmentDTO,
) {
	return {
		allowedOrigins: environment.allowedOrigins,
		allowLocalhost: environment.allowLocalhost,
		appId,
		id: environment.id,
		name: environment.name,
		redirectUris: environment.redirectUris,
	};
}

/** One client secret of an app as the REST API returns it: never the secret, only its last characters. */
export function oidcAppSecretApiJson(
	appId: string,
	secret: OauthClientSecretSummary,
) {
	return {
		appId,
		createdAt: secret.createdAt,
		environmentId: secret.environmentId,
		hint: secret.hint,
		id: secret.id,
		label: secret.label,
		lastUsedAt: secret.lastUsedAt,
	};
}
