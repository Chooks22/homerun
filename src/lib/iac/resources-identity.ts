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
