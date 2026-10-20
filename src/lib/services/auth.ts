import process from "node:process";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import {
	type OAuthOptions,
	oauthProvider,
	type Scope,
} from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt } from "better-auth/crypto";
import {
	admin,
	bearer,
	genericOAuth,
	jwt,
	openAPI,
	twoFactor,
} from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { inArray } from "drizzle-orm";
import { createLocalJWKSet, type JWK, jwtVerify } from "jose";
import { resolveAdvertisedTokenAuth } from "#lib/auth-providers.js";
import { config, isSmtpEnabled } from "#lib/config.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import { Logger } from "#lib/logger.js";
import {
	mcpAllowed,
	mcpResource,
	OIDC_CLAIMS,
	OIDC_SCOPES,
	type OidcUser,
	oidcClaimsFor,
	oidcIssuer,
} from "#lib/oidc-provider.js";
import { can, permissionsForRole } from "#lib/permissions.js";
import { passkeyRpId } from "#lib/security-policy.js";
import { withDashboardOrigin } from "#lib/server/canonical-origin.js";
import { hashClientSecret } from "#lib/server/client-secret.js";
import { db } from "#lib/server/db/lib.js";
import * as schema from "#lib/server/db/schema.js";
import { brandedEmail } from "#lib/server/email-layout.js";
import { forgetGateAccess } from "#lib/server/gate-access-cache.js";
import { building, dev } from "$app/env";
import { getRequestEvent } from "$app/server";
import { AdminService } from "./admin.service.ts";
import {
	type DirectAccessScheme,
	directAccessOrigins,
	directAccessScheme,
	trustedOriginsFor,
} from "./auth-origins.ts";
import { EmailService } from "./email.service.ts";
import {
	emailSignInPlugins,
	TWO_FACTOR_SIGN_IN_PATHS,
	UNUSED_EMAIL_OTP_PATHS,
} from "./email-sign-in.ts";
import { UserService } from "./user.service.ts";

const logger = new Logger("Auth");

/**
 * Resolves the better-auth `genericOAuth` token-endpoint auth option for one
 * configured provider. When `tokenAuthMethod` is `"auto"`, defers to
 * `resolveAdvertisedTokenAuth` over the provider's discovered methods;
 * otherwise honors the explicit `"basic"`/`"post"` choice. Returns `{}` (no
 * override) when the provider has no client secret or resolves to neither.
 */
function tokenAuthOptions(provider: {
	clientSecret: string;
	discoveredTokenAuth: string[];
	tokenAuthMethod: "auto" | "basic" | "post";
}):
	| { authentication: "basic" }
	| { tokenEndpointAuth: { method: "client_secret_post" } }
	| Record<string, never> {
	if (!provider.clientSecret) {
		return {};
	}
	const resolved =
		provider.tokenAuthMethod === "auto"
			? resolveAdvertisedTokenAuth(provider.discoveredTokenAuth)
			: provider.tokenAuthMethod;
	if (resolved === "basic") {
		return { authentication: "basic" };
	}
	if (resolved === "post") {
		return { tokenEndpointAuth: { method: "client_secret_post" } };
	}
	return {};
}

/**
 * The plugins that make Homerun an OpenID Connect provider for the apps it
 * hosts: `jwt` signs id tokens (RS256, since plenty of apps' OIDC libraries
 * don't accept EdDSA) with keys kept in the `jwks` table, and
 * `mcp` (better-auth's OAuth provider bound to the MCP endpoint as a protected
 * resource) serves authorize/token/userinfo/discovery under the auth base
 * path. Clients don't register themselves: an admin creates each one under
 * Authentication → Sign in with Homerun (a claude.ai connector included) and hands its ID and
 * secret over. The two exceptions are both public, so no secret is ever
 * issued to a stranger: an MCP client identified by its metadata document
 * (`cimd`), and a Gemini custom app, the one client dynamic registration is
 * open to (`guardRegistration` in `hooks.server.ts` refuses every other).
 * MCP only accepts an HTTPS origin (or loopback HTTP), so on any other one the
 * plain `oauthProvider` serves "Sign in with Homerun" without it: `mcp()`
 * throws on such an origin, which took the whole auth layer, and every
 * request with it, down. Empty until the dashboard's origin is known, because the issuer
 * has to be an absolute URL and `baseURL` is deliberately left unset (see
 * buildAuth); `rebuildAuth()` adds them once instance settings supply it.
 */
function oidcProviderPlugins(origin: string | undefined) {
	if (!origin) {
		return [];
	}
	const provider: OAuthOptions<Scope[]> = {
		advertisedMetadata: {
			claims_supported: [...OIDC_CLAIMS],
			scopes_supported: [...OIDC_SCOPES],
		},
		clientPrivileges: ({ user }) => {
			const owner = user as
				| { permissions?: unknown; role?: string | null }
				| undefined;
			return can(
				permissionsForRole(owner?.role, owner?.permissions),
				"users",
				"write",
			);
		},
		consentPage: "/auth/consent",
		customIdTokenClaims: ({ user, scopes }) =>
			oidcClaimsFor(user as OidcUser, scopes),
		customUserInfoClaims: ({ user, scopes }) =>
			oidcClaimsFor(user as OidcUser, scopes),
		loginPage: "/auth/sign-in",
		scopes: [...OIDC_SCOPES],
		storeClientSecret: {
			hash: hashClientSecret,
			verify: (secret, stored) => OauthClientSecretDTO.verify(secret, stored),
		},
	};
	return [
		jwt({
			jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
			jwt: { issuer: oidcIssuer(origin) },
		}),
		...(mcpAllowed(origin)
			? [
					mcp({
						...provider,
						allowDynamicClientRegistration: true,
						allowUnauthenticatedClientRegistration: true,
						resource: mcpResource(origin),
					}),
					cimd({
						fetchClientMetadataResource,
						metadataProfile: "mcp-2026-07-28",
					}),
				]
			: [oauthProvider(provider)]),
	];
}

// Doesn't throw : ORIGIN (or the Core section's Base domain + Use HTTPS on
// /settings, see config.ts's applyInstanceSettings) can also be supplied
// from the DB after boot (hooks.server.ts's init() calls rebuildAuth() once
// instance settings are loaded, before the server accepts requests), so
// nothing is configured *yet* at this module's own import time isn't
// actually an error, just worth a heads-up for anyone who hasn't set either.
if (!(process.env.ORIGIN || dev || building)) {
	logger.warn(
		"Neither ORIGIN nor a Base domain (Settings → General) is configured yet : the origin will be derived per-request until one is set.",
	);
}

/**
 * better-auth's `twoFactor` plugin with its sign-in challenge widened from
 * password sign-in to every path in `TWO_FACTOR_SIGN_IN_PATHS`, so an emailed
 * code or link still asks an account with an authenticator app for its code.
 */
function twoFactorOnEverySignIn() {
	const plugin = twoFactor({ allowPasswordless: true, issuer: "Homerun" });
	const [challenge] = plugin.hooks.after;
	return {
		...plugin,
		hooks: {
			...plugin.hooks,
			after: [
				{
					...challenge,
					matcher: (context: { path?: string }) =>
						TWO_FACTOR_SIGN_IN_PATHS.has(context.path ?? ""),
				},
			],
		},
	};
}

/**
 * Drops the cached login-wall decisions for the user a changed better-auth row
 * belongs to, so gated apps re-check them on their next request. The row can
 * be null after an update that matched nothing.
 */
function forgetGateAccessOf(userId: string | undefined): Promise<void> {
	if (userId) {
		forgetGateAccess(userId);
	}
	return Promise.resolve();
}

/**
 * Builds the better-auth instance from the current `config` (env defaults
 * merged with any DB-backed instance settings : see $lib/config.ts). Wrapped
 * in a function, rather than inlined into a single `betterAuth({...})` call
 * assigned once, so OAuth provider changes saved on the Settings page can
 * take effect live: rebuildAuth() below drops the built instances behind the
 * exported `auth` proxy, and since every consumer reads `auth.*` per-request
 * rather than destructuring it at import time, the new instance is picked up
 * immediately everywhere without a process restart. `directAccess` builds the
 * variant for a request on the instance's own IP or `localhost`: cookies
 * `Secure` only over HTTPS and never scoped to the base domain.
 */
// oxlint-disable-next-line max-lines-per-function -- one betterAuth() configuration object literal, not branching logic
function buildAuth(directAccess: DirectAccessScheme | null) {
	return betterAuth({
		advanced: {
			disableOriginCheck: false,
			...secureCookiesOption(directAccess),
			// Opt-in (AUTH_CROSS_SUBDOMAIN=true) : see config.ts for the tradeoff.
			// Required for a signed-in admin to be recognized on a gated deployed
			// service's subdomain without a separate login there.
			...(config.auth.crossSubdomainCookies && !directAccess
				? {
						crossSubDomainCookies: {
							domain: `.${config.baseDomain}`,
							enabled: true,
						},
					}
				: {}),
		},
		basePath: "/api/v1/auth",
		trustedOrigins: (request) => [
			...trustedOriginsFor({
				authOrigin: config.auth.origin,
				baseDomain: config.baseDomain,
				envOrigin: process.env.ORIGIN,
			}),
			...directAccessOrigins(request?.headers.get("host")),
		],
		// Deliberately never pinned to config.auth.origin (the Core section's
		// Base domain + Use HTTPS on /settings/onboarding). Real, tested-in-
		// review bug this replaced: better-auth's svelteKitHandler only
		// forwards a request to its own handler when the request's origin
		// matches options.baseURL's origin exactly (confirmed in
		// node_modules/better-auth/dist/integrations/svelte-kit.mjs's
		// isAuthPath : `if (_url.origin !== baseURL.origin) return false`) ;
		// with baseURL pinned, *every* /api/v1/auth/* call from any origin
		// other than the exact configured one 404s instead of reaching
		// better-auth at all (SvelteKit's own router has no route for that
		// path, only better-auth does), including sign-in itself. That's a
		// real, easy-to-hit lockout : the configured Base domain frequently
		// doesn't match how the instance is actually being reached yet
		// (behind a reverse proxy before DNS/TLS are fully wired, a bare IP
		// or different port during initial setup, etc.), and onboarding
		// makes Base domain mandatory, so this used to break auth
		// immediately after finishing it. Leaving baseURL undefined makes
		// svelteKitHandler derive the origin from each incoming request
		// instead (same "port-mismatch" reasoning this comment used to give
		// only for the *unconfigured* case, now applied unconditionally) :
		// isAuthPath's own baseURL then always has the same origin as the
		// request by construction, so it can never mismatch. config.auth.origin
		// has no other consumer in this codebase (grep it), Base domain
		// itself is still what Traefik routing (config.baseDomain) uses.

		disabledPaths: ["/token", ...UNUSED_EMAIL_OTP_PATHS],
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema,
		}),
		databaseHooks: {
			account: {
				create: { after: (row) => forgetGateAccessOf(row?.userId) },
				delete: { after: (row) => forgetGateAccessOf(row?.userId) },
				update: { after: (row) => forgetGateAccessOf(row?.userId) },
			},
			session: {
				create: {
					before: async (row) => {
						if (await UserService.isServiceAccount(row.userId)) {
							logger.warn(
								`Refused a session for a service account: user=${row.userId}`,
							);
							return false;
						}
					},
					after: async (row) => {
						if (!row.impersonatedBy) {
							await UserService.recordSignIn(row.userId, row.createdAt);
						}
					},
				},
			},
			user: {
				create: {
					// The very first account on the instance becomes admin,
					// regardless of which path created it (self-service sign-up is
					// the only one reachable while hasAnyUser() is still false : see
					// hooks.server.ts). Real, tested-in-review finding: gating this
					// on "!user.role" doesn't work : the admin plugin registers its
					// own databaseHooks.user.create.before (setting role to
					// defaultRole) via its init(), and depending on hook-merge order
					// that can run *before* this one, making `user.role` already
					// truthy by the time this hook sees it (verified live: the
					// bootstrap account came out "developer", not "admin", with that
					// guard). Checking hasAnyUser() directly instead sidesteps hook
					// ordering entirely : both hooks run pre-insert, so it's still
					// reliably false only before the very first user exists. Every
					// other creation path (admin-direct-create, invite-accept)
					// always passes an explicit role and runs once hasAnyUser() is
					// already true, so this never overrides those.
					before: async (user) => {
						if (await AdminService.hasAnyUser()) {
							return;
						}
						return { data: { ...user, role: "admin" } };
					},
				},
				delete: { after: (row) => forgetGateAccessOf(row?.id) },
				update: { after: (row) => forgetGateAccessOf(row?.id) },
			},
		},
		emailAndPassword: {
			disableSignUp: false,
			enabled: true,
			minPasswordLength: 12,
		},
		emailVerification: {
			sendOnSignUp: isSmtpEnabled(),
			sendVerificationEmail: async (params) => {
				if (!isSmtpEnabled()) {
					logger.warn(
						`Skipping verification email to ${params.user.email}: SMTP isn't configured`,
					);
					return;
				}
				const email = new EmailService({
					...brandedEmail({
						action: {
							label: "Verify my email",
							url: withDashboardOrigin(params.url),
						},
						footnote:
							"If you didn't create a Homerun account, ignore this email.",
						heading: "Verify your email address",
						paragraphs: [
							"Confirm this is your address to finish setting up your Homerun account.",
						],
					}),
					subject: "Verify your email address",
					to: params.user.email,
				});
				await email.send();
			},
		},
		onAPIError: {
			errorURL: "/auth/error",
		},
		logger: {
			level: dev ? "debug" : config.logLevel,
			log: (level, message, ...metadata) => {
				if (message.startsWith("[better-auth] Base URL is not set")) {
					return;
				}
				// Send logs to a custom logging service
				logger.log({
					level,
					message,
					metadata,
				});
			},
		},
		plugins: [
			openAPI({
				disableDefaultReference: true,
				path: "/openapi",
			}),
			// Real, tested-in-review finding, from actually driving the REST
			// API hard enough (this app's own new integration test suite,
			// tests/integration/) to hit it : apiKey()'s own default rate
			// limit, unset here before, is 10 requests per *24 hours* per key
			// (node_modules/@better-auth/api-key's own default). Every
			// api-key-authenticated request (hooks.server.ts's authHandler
			// calls verifyApiKey() for each one) counts against it, so the
			// REST API, the CLI built on it, and any dashboard-side polling
			// using a key would all get silently 401'd (hooks.server.ts
			// treats a rate-limited verifyApiKey() result identically to an
			// actually-invalid key) after just 10 calls, not a deliberate
			// choice anywhere in this app's own design. 3000/minute leaves
			// room for a Terraform plan over a large stack (one request per
			// resource) while still keeping *some* abuse protection, rather
			// than removing rate limiting outright.
			apiKey({
				enableMetadata: true,
				rateLimit: { maxRequests: 3000, timeWindow: 60_000 },
			}),
			passkey({
				rpID: passkeyRpId(config.auth.origin),
				rpName: "Homerun",
			}),
			twoFactorOnEverySignIn(),
			...emailSignInPlugins(),
			// "developer" is the sane fallback default : every real creation
			// path (admin-direct-create, invite-accept) always passes an
			// explicit role, and the bootstrap-admin case is handled by the
			// databaseHooks below, not this option.
			admin({ defaultRole: "developer" }),
			bearer(),
			genericOAuth({
				config: config.auth.oauthProviders.map((provider) => ({
					clientId: provider.clientId,
					clientSecret: provider.clientSecret,
					discoveryUrl: provider.discoveryUrl,
					enabled: provider.enabled,
					disableProviderLogout: !provider.signOutOfProvider,
					pkce: provider.pkce,
					providerId: provider.name,
					scopes: provider.scopes,
					...tokenAuthOptions(provider),
				})),
			}),
			...oidcProviderPlugins(config.auth.origin),
			sveltekitCookies(getRequestEvent),
		],
		rateLimit: {
			// Disabled in dev for easier testing, and also when
			// HOMERUN_DISABLE_AUTH_RATE_LIMIT=1 : real, tested finding building
			// tests/e2e/'s own sign-in/sign-out coverage — better-auth's rate
			// limiter has an undocumented-in-config default "special rule" (see
			// its own rate-limiter/index.mjs's getDefaultSpecialRules) capping
			// any "/sign-in"/"/sign-up"-prefixed path at 3 requests per 10
			// seconds, well below this `max`/`window`, and unaffected by them.
			// A handful of E2E specs signing in/up against a real production
			// build (`dev` is false there, same as a real deployment) tripped it
			// immediately. `HOMERUN_DISABLE_AUTH_RATE_LIMIT` is set only by
			// tests/e2e/support/bootstrap-runtime.ts's spawned app, never in
			// production, same "test-only env escape hatch" shape as
			// HOMERUN_SKIP_INTEGRATION_SETUP elsewhere in this repo.
			enabled: !dev && process.env.HOMERUN_DISABLE_AUTH_RATE_LIMIT !== "1",
			max: 100, // limit each IP to 100 requests per window
			window: 15 * 60 * 1000, // 15 minutes
		},
		secret: config.auth.secret,
		user: {
			additionalFields: {
				permissions: { input: false, required: false, type: "json" },
				type: {
					defaultValue: "human",
					input: false,
					required: false,
					type: "string",
				},
			},
			changeEmail: {
				enabled: true,
				sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
					if (!isSmtpEnabled()) {
						logger.warn(
							`Skipping email-change confirmation to ${user.email}: SMTP isn't configured`,
						);
						return;
					}
					const email = new EmailService({
						...brandedEmail({
							action: {
								label: "Confirm the change",
								url: withDashboardOrigin(url),
							},
							footnote:
								"If you didn't ask for this, ignore this email: your address stays as it is.",
							heading: "Confirm your new email address",
							paragraphs: [
								`Someone asked to change your Homerun account email to ${newEmail}. Confirm it to make the switch.`,
							],
						}),
						subject: "Confirm your new email address",
						to: user.email,
					});
					await email.send();
				},
				updateEmailWithoutVerification: true,
			},
			deleteUser: {
				// Extracted to user.service.ts : the admin Users page's "remove
				// user" action needs the exact same cleanup and can't get it for
				// free from better-auth's admin.removeUser (see that module's
				// docstring for why). Thin wrapper here keeps self-service account
				// deletion unchanged.
				beforeDelete: async (user) => {
					await UserService.cleanupUserResources(user.id);
				},
				enabled: true,
			},
		},
	});
}

type Auth = ReturnType<typeof buildAuth>;

/**
 * The `useSecureCookies` override for one auth instance: the request's own
 * scheme on direct IP/localhost access, else `ORIGIN`'s scheme, else none so
 * better-auth falls back to its `isProduction` default.
 */
function secureCookiesOption(
	directAccess: DirectAccessScheme | null,
): { useSecureCookies: boolean } | Record<string, never> {
	if (directAccess) {
		return { useSecureCookies: directAccess === "https" };
	}
	if (process.env.ORIGIN) {
		return { useSecureCookies: process.env.ORIGIN.startsWith("https://") };
	}
	return {};
}

let instances = new Map<DirectAccessScheme | "configured", Auth>();

/**
 * The auth instance whose cookies suit the current request: a direct-access
 * variant on an IP or `localhost` (see `directAccessScheme`), the configured
 * one otherwise and outside a request.
 */
function currentInstance(): Auth {
	let scheme: DirectAccessScheme | null = null;
	try {
		const { request } = getRequestEvent();
		scheme = directAccessScheme(
			request.headers.get("host"),
			request.headers.get("x-forwarded-proto"),
		);
	} catch {
		scheme = null;
	}
	const key = scheme ?? "configured";
	let instance = instances.get(key);
	if (!instance) {
		instance = buildAuth(scheme);
		instances.set(key, instance);
	}
	return instance;
}

export const auth: Auth = new Proxy({} as Auth, {
	get: (_target, property) => Reflect.get(currentInstance(), property),
});

/** Drops every built auth instance so the next use rebuilds from the current config : see buildAuth()'s docstring. */
export function rebuildAuth(): void {
	instances = new Map();
	currentInstance();
	logger.info("Rebuilt auth instance from updated instance settings");
}

/**
 * Deletes the OIDC signing keys the current auth secret can't decrypt. The
 * `jwt` plugin signs a token on every session fetch, so one such key (left by
 * an earlier AUTH_SECRET) failed every sign-in with "Failed to decrypt private
 * key". A key that can't be decrypted can never sign again anyway; the plugin
 * mints a fresh one on its next signature. Tokens apps got from the old key
 * stop verifying, so their users sign in to those apps again.
 */
export async function pruneUndecryptableSigningKeys(): Promise<void> {
	const ctx = await auth.$context;
	const rows = await db
		.select({ id: schema.jwks.id, privateKey: schema.jwks.privateKey })
		.from(schema.jwks);
	const stale: string[] = [];
	for (const row of rows) {
		// oxlint-disable-next-line no-await-in-loop -- Decrypting keys is fairly fast.
		const readable = await symmetricDecrypt({
			data: JSON.parse(row.privateKey) as string,
			key: ctx.secretConfig,
		})
			.then(() => true)
			.catch(() => false);
		if (!readable) {
			stale.push(row.id);
		}
	}
	if (stale.length === 0) {
		return;
	}
	await db.delete(schema.jwks).where(inArray(schema.jwks.id, stale));
	logger.warn(
		`Deleted ${stale.length} OIDC signing key(s) the current AUTH_SECRET can't decrypt (the secret changed since they were made). A new key is created on the next sign-in; apps using "Sign in with Homerun" need their users to sign in again.`,
	);
}

export type AuthType = typeof auth.$Infer.Session;

/**
 * The user id an MCP access token was issued to, or null when it doesn't
 * verify: signed with one of Homerun's own keys, issued by Homerun, typed as
 * an access token and bound to the MCP endpoint. An id token, or a token
 * minted for an app using "Sign in with Homerun", has another audience and is
 * refused.
 */
export async function verifyMcpAccessToken(
	token: string,
): Promise<string | null> {
	const origin = config.auth.origin;
	if (!origin) {
		return null;
	}
	const rows = await db
		.select({
			alg: schema.jwks.alg,
			id: schema.jwks.id,
			publicKey: schema.jwks.publicKey,
		})
		.from(schema.jwks);
	const keys = createLocalJWKSet({
		keys: rows.map((row) => ({
			...(JSON.parse(row.publicKey) as JWK),
			alg: row.alg ?? "RS256",
			kid: row.id,
		})),
	});
	try {
		const { payload } = await jwtVerify(token, keys, {
			audience: mcpResource(origin),
			issuer: oidcIssuer(origin),
			typ: "at+jwt",
		});
		return payload.sub ?? null;
	} catch {
		return null;
	}
}
