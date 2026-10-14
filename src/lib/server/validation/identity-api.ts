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

const secretAuthMethod = z
	.enum(["client_secret_basic", "client_secret_post"])
	.meta({
		description:
			"How a confidential app sends its secret to the token endpoint: client_secret_basic (HTTP Basic) or client_secret_post (request body). Not taken by a public app.",
	});

const oidcAppName = text.min(1).max(100);

export const createOidcAppApiBody = z
	.object({
		confidential: z.boolean().default(true).meta({
			description:
				"A confidential app (a server) authenticates with a client secret; a public one (a SPA or mobile app) has none and always uses PKCE. Can't change later.",
		}),
		disabled: z
			.boolean()
			.default(false)
			.describe("A disabled app can't start new sign-ins."),
		enableEndSession: z
			.boolean()
			.default(false)
			.describe(
				"Let the app sign people out of Homerun (RP-initiated logout).",
			),
		name: oidcAppName,
		requirePkce: z
			.boolean()
			.optional()
			.describe(
				"Require a PKCE challenge on every sign-in. Defaults to true, and a public app can't turn it off.",
			),
		skipConsent: z
			.boolean()
			.default(false)
			.describe("Sign people in without asking them to share their profile."),
		tokenAuthMethod: secretAuthMethod.optional(),
	})
	.superRefine((body, context) => {
		if (body.confidential) {
			return;
		}
		if (body.tokenAuthMethod) {
			context.addIssue({
				code: "custom",
				message: "A public app has no secret, so no token auth method.",
				path: ["tokenAuthMethod"],
			});
		}
		if (body.requirePkce === false) {
			context.addIssue({
				code: "custom",
				message: "A public app always requires PKCE.",
				path: ["requirePkce"],
			});
		}
	});

export const updateOidcAppApiBody = z.object({
	disabled: z.boolean().optional(),
	enableEndSession: z.boolean().optional(),
	name: oidcAppName.optional(),
	requirePkce: z.boolean().optional(),
	skipConsent: z.boolean().optional(),
	tokenAuthMethod: secretAuthMethod.optional(),
});

const environmentFields = {
	allowedOrigins: z.array(text.min(1)).meta({
		description:
			"Browser origins (scheme, host and port) allowed to call the token endpoint for this environment, for a SPA.",
	}),
	allowLocalhost: z
		.boolean()
		.describe(
			"Accept http://localhost callbacks and origins, for development only.",
		),
	name: text.meta({
		description:
			"Up to 32 letters, digits, spaces, dots, dashes or underscores, unique per app.",
	}),
	redirectUris: z.array(text.min(1)).min(1).meta({
		description:
			"The callback URLs codes may be sent to: https, or http on localhost when allowLocalhost is on.",
	}),
};

export const createOidcAppEnvironmentApiBody = z.object({
	...environmentFields,
	allowedOrigins: environmentFields.allowedOrigins.default([]),
	allowLocalhost: environmentFields.allowLocalhost.default(false),
});

export const updateOidcAppEnvironmentApiBody = z.object({
	allowedOrigins: environmentFields.allowedOrigins.optional(),
	allowLocalhost: environmentFields.allowLocalhost.optional(),
	name: environmentFields.name.optional(),
	redirectUris: environmentFields.redirectUris.optional(),
});

export const createOidcAppSecretApiBody = z.object({
	environmentId: text.min(1).describe("The environment the secret works in."),
	label: text
		.max(64)
		.optional()
		.describe('What the secret is for. Defaults to "Client secret".'),
});
