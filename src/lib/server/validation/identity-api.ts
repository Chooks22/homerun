import { z } from "zod";
import {
	PERMISSION_AREAS,
	PERMISSION_LEVELS,
	USER_ROLES,
} from "#lib/permissions.js";

const text = z.string().trim();

const permissionsField = z
	.partialRecord(
		z.enum(PERMISSION_AREAS.map((area) => area.key)),
		z.enum(PERMISSION_LEVELS),
	)
	.meta({
		description:
			'Dashboard and API areas a custom-role user may use, each "read" or "write". Only taken with the custom role.',
	});

const email = text
	.toLowerCase()
	.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address.");

const role = z.enum(USER_ROLES).meta({
	description:
		"admin, developer, viewer (read-only), app-user (only gets through the login walls that let them in) or custom (the permissions given).",
});

export const createUserApiBody = z.object({
	email,
	name: text.min(1).max(100),
	permissions: permissionsField.optional(),
	role: role.default("developer"),
});

export const updateUserApiBody = z.object({
	email: email.optional(),
	name: text.min(1).max(100).optional(),
	permissions: permissionsField.optional(),
	role: role.optional(),
});

const providerName = text.toLowerCase().min(1).meta({
	description:
		'Lowercase letters, digits and hyphens. Part of the redirect URI (<dashboard>/api/v1/auth/callback/<name>) and of the login wall method "oauth:<name>", so it can\'t change.',
});

const tokenAuthMethod = z.enum(["auto", "basic", "post"]).meta({
	description:
		"How the client secret reaches the token endpoint: auto (HTTP Basic when the provider advertises it, else the request body), basic or post.",
});

export const createOauthProviderApiBody = z.object({
	clientId: text.min(1),
	clientSecret: text
		.min(1)
		.optional()
		.describe("The OAuth client secret. Write-only."),
	discoveryUrl: text
		.min(1)
		.describe(
			"The provider's OpenID discovery document, fetched on save to check it.",
		),
	enabled: z.boolean().default(true),
	label: text
		.optional()
		.describe('Shown on the "Continue with" button. Defaults to the name.'),
	name: providerName,
	pkce: z.boolean().default(true),
	scopes: z.array(text.min(1)).default(["openid", "profile", "email"]),
	signOutOfProvider: z
		.boolean()
		.default(false)
		.describe(
			"Signing out of Homerun also signs out of the provider (RP-initiated logout).",
		),
	tokenAuthMethod: tokenAuthMethod.default("auto"),
});

export const updateOauthProviderApiBody = z.object({
	clientId: text.min(1).optional(),
	clientSecret: text
		.min(1)
		.optional()
		.describe("A new client secret. Omitted keeps the stored one."),
	discoveryUrl: text.min(1).optional(),
	enabled: z.boolean().optional(),
	label: text.optional(),
	pkce: z.boolean().optional(),
	scopes: z.array(text.min(1)).optional(),
	signOutOfProvider: z.boolean().optional(),
	tokenAuthMethod: tokenAuthMethod.optional(),
});
