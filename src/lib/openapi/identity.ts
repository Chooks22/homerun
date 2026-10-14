import { z } from "zod";
import {
	PERMISSION_AREAS,
	PERMISSION_LEVELS,
	USER_ROLES,
} from "#lib/permissions.js";
import {
	createOauthProviderApiBody,
	createUserApiBody,
	updateOauthProviderApiBody,
	updateUserApiBody,
} from "#lib/server/validation/identity-api.js";
import { oidcAppRoutes } from "./oidc-apps";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

export const userResponse = z.object({
	createdAt: timestamp,
	email: z.string(),
	emailVerified: z.boolean(),
	id: z.string(),
	lastSignInAt: timestamp.nullable(),
	name: z.string(),
	permissions: z
		.partialRecord(
			z.enum(PERMISSION_AREAS.map((area) => area.key)),
			z.enum(PERMISSION_LEVELS),
		)
		.meta({
			description:
				"The user's own permissions with the custom role, {} with any other (the role decides)",
		}),
	role: z.enum(USER_ROLES),
	updatedAt: timestamp,
});

export const oauthProviderResponse = z.object({
	clientId: z.string(),
	clientSecretSet: z.boolean(),
	discoveryUrl: z.string(),
	enabled: z.boolean(),
	id: z.string().meta({ description: "The provider's name" }),
	label: z.string(),
	name: z.string(),
	pkce: z.boolean(),
	scopes: z.array(z.string()),
	signOutOfProvider: z.boolean(),
	tokenAuthMethod: z.enum(["auto", "basic", "post"]),
});

const unauthorized: ResponseDef = {
	description: "Unauthorized",
	schema: errorResponse,
};
const notFound: ResponseDef = {
	description: "Not found",
	schema: errorResponse,
};
const refused: ResponseDef = {
	description: "Invalid body, or a change the instance refuses",
	schema: errorResponse,
};
const deleted: ResponseDef = { description: "Deleted" };

const userParam: ParamDef[] = [{ description: "User id", name: "userId" }];
const providerParam: ParamDef[] = [
	{ description: "Provider name", name: "providerName" },
];
const userTags = ["Users"];
const providerTags = ["Authentication"];

export const identityRoutes: RouteDef[] = [
	{
		description:
			"Every human account, newest first; service accounts are under /service-accounts. Paginated: the body is the page, x-total-count, x-page and x-per-page carry the rest.",
		method: "get",
		path: "/users",
		queryParams: [
			{ description: "1-based page number (default 1)", name: "page" },
			{ description: "Items per page (default 100, max 200)", name: "perPage" },
			{ description: "Searches names and emails", name: "q" },
			{ description: "Only users with this role", name: "role" },
		],
		responses: {
			200: { description: "The users", isArray: true, schema: userResponse },
			401: unauthorized,
		},
		summary: "List users",
		tags: userTags,
	},
	{
		description:
			"Creates an account with no password, like Users → Add user: its owner picks one at their first sign-in, after an emailed code when SMTP is configured. Without SMTP anyone who knows the address can claim it first.",
		method: "post",
		path: "/users",
		requestBody: createUserApiBody,
		responses: {
			201: { description: "Created", schema: userResponse },
			400: refused,
			401: unauthorized,
		},
		summary: "Create a user",
		tags: userTags,
	},
	{
		method: "get",
		path: "/users/{userId}",
		pathParams: userParam,
		responses: {
			200: { description: "The user", schema: userResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a user",
		tags: userTags,
	},
	{
		description:
			"Changes the fields sent and keeps the rest. Refuses demoting the last admin, an email another account holds, and permissions without the custom role; switching to custom without permissions starts from the previous role's.",
		method: "patch",
		path: "/users/{userId}",
		pathParams: userParam,
		requestBody: updateUserApiBody,
		responses: {
			200: { description: "Updated", schema: userResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Update a user",
		tags: userTags,
	},
	{
		description:
			"Hands what the user created over to the caller, then deletes the account. Refuses the caller's own account and the last admin.",
		method: "delete",
		path: "/users/{userId}",
		pathParams: userParam,
		responses: {
			204: deleted,
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Delete a user",
		tags: userTags,
	},
	{
		description:
			"The OAuth/OIDC providers people can sign in with (Authentication → Providers), without their secrets.",
		method: "get",
		path: "/oauth-providers",
		responses: {
			200: {
				description: "The providers",
				isArray: true,
				schema: oauthProviderResponse,
			},
			401: unauthorized,
		},
		summary: "List OAuth sign-in providers",
		tags: providerTags,
	},
	{
		description:
			"Adds a provider once its discovery document answers, and applies it right away.",
		method: "post",
		path: "/oauth-providers",
		requestBody: createOauthProviderApiBody,
		responses: {
			201: { description: "Created", schema: oauthProviderResponse },
			400: refused,
			401: unauthorized,
		},
		summary: "Create an OAuth sign-in provider",
		tags: providerTags,
	},
	{
		method: "get",
		path: "/oauth-providers/{providerName}",
		pathParams: providerParam,
		responses: {
			200: { description: "The provider", schema: oauthProviderResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get an OAuth sign-in provider",
		tags: providerTags,
	},
	{
		description:
			"Changes the fields sent and keeps the rest, checking the discovery document again. A missing clientSecret keeps the stored one.",
		method: "patch",
		path: "/oauth-providers/{providerName}",
		pathParams: providerParam,
		requestBody: updateOauthProviderApiBody,
		responses: {
			200: { description: "Updated", schema: oauthProviderResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Update an OAuth sign-in provider",
		tags: providerTags,
	},
	{
		description:
			'Removes the provider. Login walls listing "oauth:<name>" stop offering it.',
		method: "delete",
		path: "/oauth-providers/{providerName}",
		pathParams: providerParam,
		responses: { 204: deleted, 401: unauthorized, 404: notFound },
		summary: "Delete an OAuth sign-in provider",
		tags: providerTags,
	},
	...oidcAppRoutes,
];
