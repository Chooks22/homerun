import type { IacAttribute, IacKind, IacResource } from "#lib/iac/resources.js";
import {
	PERMISSION_AREAS,
	PERMISSION_LEVELS,
	USER_ROLES,
} from "#lib/permissions.js";

/** One attribute, its Terraform name the snake_case of its API field. */
function field(
	name: string,
	kind: IacKind,
	options: Omit<Partial<IacAttribute>, "kind" | "name"> = {},
): IacAttribute {
	return {
		kind,
		name,
		tf: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
		...options,
	};
}

const required = { required: true };

export const IAC_IDENTITY_RESOURCES: IacResource[] = [
	{
		attributes: [
			field("email", "string", required),
			field("name", "string", required),
			field("role", "string", {
				default: "developer",
				description: `One of ${USER_ROLES.join(", ")}. viewer is read-only, app-user only gets through the login walls that let them in, custom holds the permissions set here. The last admin can't be demoted.`,
			}),
			field("permissions", "stringMap", {
				description: `Only with role custom: the areas the user may use, each set to ${PERMISSION_LEVELS.join(" or ")}. Areas: ${PERMISSION_AREAS.map((area) => area.key).join(", ")}. Switching to custom without it starts from the previous role's permissions.`,
			}),
			field("emailVerified", "bool", { readOnly: true }),
		],
		collectionPath: "/users",
		description:
			"A person's account. It's created without a password, like Users → Add user: its owner picks one at their first sign-in, after an emailed code when SMTP is configured (without SMTP, anyone who knows the address can claim it first). Destroying it hands what the user created over to the provider's own account; the last admin and the provider's own account can't be destroyed. Service accounts are homerun_service_account.",
		importId: ["id"],
		itemPath: "/users/{id}",
		label: "email",
		type: "homerun_user",
	},
	{
		attributes: [
			field("name", "string", {
				description:
					'Lowercase letters, digits and hyphens. It ends the redirect URI to register with the provider (the dashboard URL, then /api/v1/auth/callback/ and the name) and makes the login wall method "oauth:" followed by the name. Changing it replaces the provider.',
				forceNew: true,
				required: true,
			}),
			field("label", "string", {
				description: 'Shown on the "Continue with" button. Defaults to name.',
			}),
			field("clientId", "string", required),
			field("clientSecret", "string", { sensitive: true, writeOnly: true }),
			field("clientSecretSet", "bool", { readOnly: true }),
			field("discoveryUrl", "string", {
				description:
					"The provider's OpenID discovery document (…/.well-known/openid-configuration). Every save fetches it, and refuses one that doesn't answer with an issuer.",
				required: true,
			}),
			field("enabled", "bool", { default: true }),
			field("pkce", "bool", { default: true }),
			field("scopes", "strings", {
				default: ["openid", "profile", "email"],
			}),
			field("signOutOfProvider", "bool", {
				default: false,
				description:
					"Signing out of Homerun also signs out of the provider (RP-initiated logout).",
			}),
			field("tokenAuthMethod", "string", {
				default: "auto",
				description:
					"How the client secret reaches the token endpoint: auto (HTTP Basic when the provider advertises it, else the request body), basic or post.",
			}),
		],
		collectionPath: "/oauth-providers",
		description:
			"An OAuth/OIDC provider people sign in with (Authentication → Providers). Applied as soon as it's saved. A login wall offers it as the method oauth: followed by its name.",
		importId: ["id"],
		itemPath: "/oauth-providers/{id}",
		label: "name",
		type: "homerun_oauth_provider",
	},
	{
		attributes: [
			field("name", "string", required),
			field("confidential", "bool", {
				default: true,
				description:
					"A confidential app (a server) authenticates with a client secret (homerun_oidc_app_secret); a public one (a SPA or mobile app) has none and always uses PKCE. Changing it replaces the app, and with it the client id.",
				forceNew: true,
			}),
			field("tokenAuthMethod", "string", {
				description:
					"How a confidential app sends its secret to the token endpoint: client_secret_basic (HTTP Basic, the default) or client_secret_post (request body, what Claude's connector uses). Leave it unset on a public app.",
			}),
			field("requirePkce", "bool", {
				default: true,
				description:
					"Require a PKCE challenge on every sign-in. A public app can't turn it off.",
			}),
			field("skipConsent", "bool", {
				default: false,
				description:
					"Sign people in without asking them to share their profile.",
			}),
			field("enableEndSession", "bool", {
				default: false,
				description:
					"Let the app sign people out of Homerun (RP-initiated logout).",
			}),
			field("disabled", "bool", {
				default: false,
				description: "Refuse new sign-ins without deleting the app.",
			}),
			field("clientId", "string", {
				description: "The client id to configure the app with.",
				readOnly: true,
			}),
			field("discoveryUrl", "string", {
				description:
					"The OpenID discovery document to point the app at, empty until the Dashboard URL is set.",
				readOnly: true,
			}),
		],
		collectionPath: "/oidc-apps",
		description:
			'An app that signs people in with their Homerun account ("Sign in with Homerun", Authentication → Sign in with Homerun). Nobody can sign in until it has a homerun_oidc_app_environment with its callback URLs; a confidential app also needs a homerun_oidc_app_secret.',
		importId: ["id"],
		itemPath: "/oidc-apps/{id}",
		label: "name",
		type: "homerun_oidc_app",
	},
	{
		attributes: [
			field("appId", "string", {
				forceNew: true,
				ref: "homerun_oidc_app",
				required: true,
			}),
			field("name", "string", {
				description:
					"Up to 32 letters, digits, spaces, dots, dashes or underscores, unique per app: production, staging…",
				required: true,
			}),
			field("redirectUris", "strings", {
				description:
					"The callback URLs codes may be sent to, from the app's own OIDC settings: https, or http on localhost when allow_localhost is on.",
				required: true,
			}),
			field("allowedOrigins", "strings", {
				default: [],
				description:
					"Browser origins (scheme, host and port) allowed to call the token endpoint, for a SPA.",
			}),
			field("allowLocalhost", "bool", {
				default: false,
				description:
					"Accept localhost callbacks and origins, for a development environment.",
			}),
		],
		collectionPath: "/oidc-apps/{appId}/environments",
		description:
			"One environment of a homerun_oidc_app, with its own callback URLs and authorized origins. A client secret only redeems codes sent to its own environment's callbacks.",
		importId: ["appId", "id"],
		itemPath: "/oidc-apps/{appId}/environments/{id}",
		label: "name",
		type: "homerun_oidc_app_environment",
	},
	{
		attributes: [
			field("appId", "string", {
				forceNew: true,
				ref: "homerun_oidc_app",
				required: true,
			}),
			field("environmentId", "string", {
				forceNew: true,
				ref: "homerun_oidc_app_environment",
				required: true,
			}),
			field("label", "string", {
				description: 'What the secret is for. Defaults to "Client secret".',
				forceNew: true,
			}),
			field("secret", "string", {
				description:
					"The client secret, only known to a secret Terraform created: an imported one has none.",
				readOnly: true,
				returnedOnCreate: true,
				sensitive: true,
			}),
			field("hint", "string", {
				description: "The secret's last four characters.",
				readOnly: true,
			}),
		],
		collectionPath: "/oidc-apps/{appId}/secrets",
		description:
			"A client secret of a confidential homerun_oidc_app, for one of its environments. It's generated on create and kept in the state, so treat the state as a secret; rotate it by creating the new one before destroying the old.",
		importId: ["appId", "id"],
		itemPath: "/oidc-apps/{appId}/secrets/{id}",
		label: "label",
		type: "homerun_oidc_app_secret",
	},
];

/**
 * A login wall's method and allow-list attributes on homerun_service, its
 * own (`prefix` "auth") or its previews' ("previewAuth"), described with
 * the method ids that exist and the fact that an emailed method lets any
 * account through unless an allow list narrows it.
 */
export function loginWallAttributes(
	prefix: "auth" | "previewAuth",
): IacAttribute[] {
	const tf = prefix === "auth" ? "auth" : "preview_auth";
	return [
		field(`${prefix}Providers`, "strings", {
			description: `Sign-in methods the wall offers: "password", "email-otp" (an emailed code), "magic-link" (an emailed link) and "oauth:" followed by a homerun_oauth_provider's name (oauth:pocket-id). Each must be enabled on the instance (the emailed ones in homerun_authentication_settings, with SMTP set up) or the API refuses it, and ${tf}_required needs at least one. An emailed method proves only the mailbox, so it lets any Homerun account through unless ${tf}_allowed_emails or ${tf}_allowed_user_ids narrow it.`,
		}),
		field(`${prefix}AllowedEmails`, "strings", {
			description:
				"Addresses, or *@domain patterns, an account's email must match to get in. Empty lets any address through.",
		}),
		field(`${prefix}AllowedGroups`, "strings", {
			description:
				"OIDC groups (from a linked provider) or Homerun roles, one of which an account must have to get in. Empty skips the check.",
		}),
		field(`${prefix}AllowedUserIds`, "strings", {
			description:
				"The only accounts let in, by id (a homerun_user or homerun_service_account id). Empty lets every account through the other rules; a service account only ever gets in when listed here.",
		}),
	];
}
