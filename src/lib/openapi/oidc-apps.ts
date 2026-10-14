import { z } from "zod";
import {
	createOidcAppApiBody,
	createOidcAppEnvironmentApiBody,
	createOidcAppSecretApiBody,
	updateOidcAppApiBody,
	updateOidcAppEnvironmentApiBody,
} from "#lib/server/validation/identity-api.js";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

export const oidcAppResponse = z.object({
	clientId: z
		.string()
		.meta({ description: "The client id the app signs in with" }),
	confidential: z.boolean(),
	createdAt: timestamp.nullable(),
	disabled: z.boolean(),
	discoveryUrl: z.string().nullable().meta({
		description:
			"The OpenID discovery document to point the app at, null until the Dashboard URL is set",
	}),
	enableEndSession: z.boolean(),
	id: z.string(),
	name: z.string(),
	requirePkce: z.boolean(),
	skipConsent: z.boolean(),
	tokenAuthMethod: z
		.enum(["client_secret_basic", "client_secret_post"])
		.nullable()
		.meta({ description: "null for a public app" }),
});

export const oidcAppEnvironmentResponse = z.object({
	allowedOrigins: z.array(z.string()),
	allowLocalhost: z.boolean(),
	appId: z.string(),
	id: z.string(),
	name: z.string(),
	redirectUris: z.array(z.string()),
});

export const oidcAppSecretResponse = z.object({
	appId: z.string(),
	createdAt: timestamp,
	environmentId: z.string(),
	hint: z.string().meta({ description: "The secret's last four characters" }),
	id: z.string(),
	label: z.string(),
	lastUsedAt: timestamp.nullable(),
});

const createdSecretResponse = oidcAppSecretResponse.extend({
	secret: z.string().meta({
		description: "The client secret, returned this once and never again",
	}),
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

const appParam: ParamDef[] = [{ description: "App id", name: "appId" }];
const environmentParams: ParamDef[] = [
	...appParam,
	{ description: "Environment id", name: "environmentId" },
];
const secretParams: ParamDef[] = [
	...appParam,
	{ description: "Secret id", name: "secretId" },
];
const tags = ["Authentication"];

export const oidcAppRoutes: RouteDef[] = [
	{
		description:
			'The apps registered to use "Sign in with Homerun" (Homerun as an OIDC provider), newest first.',
		method: "get",
		path: "/oidc-apps",
		responses: {
			200: { description: "The apps", isArray: true, schema: oidcAppResponse },
			401: unauthorized,
		},
		summary: "List OIDC apps",
		tags,
	},
	{
		description:
			"Registers an app with no environment: add one with its callback URLs before anyone can sign in, and mint a confidential app's secret under /secrets.",
		method: "post",
		path: "/oidc-apps",
		requestBody: createOidcAppApiBody,
		responses: {
			201: { description: "Created", schema: oidcAppResponse },
			400: refused,
			401: unauthorized,
		},
		summary: "Create an OIDC app",
		tags,
	},
	{
		method: "get",
		path: "/oidc-apps/{appId}",
		pathParams: appParam,
		responses: {
			200: { description: "The app", schema: oidcAppResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get an OIDC app",
		tags,
	},
	{
		description:
			"Changes the fields sent and keeps the rest. A public app takes neither a token auth method nor requirePkce false.",
		method: "patch",
		path: "/oidc-apps/{appId}",
		pathParams: appParam,
		requestBody: updateOidcAppApiBody,
		responses: {
			200: { description: "Updated", schema: oidcAppResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Update an OIDC app",
		tags,
	},
	{
		description:
			"Deletes the app with its environments, secrets, tokens and consents: anyone signed in to it through Homerun loses access at their next token use.",
		method: "delete",
		path: "/oidc-apps/{appId}",
		pathParams: appParam,
		responses: { 204: deleted, 401: unauthorized, 404: notFound },
		summary: "Delete an OIDC app",
		tags,
	},
	{
		method: "get",
		path: "/oidc-apps/{appId}/environments",
		pathParams: appParam,
		responses: {
			200: {
				description: "The app's environments, oldest first",
				isArray: true,
				schema: oidcAppEnvironmentResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "List an OIDC app's environments",
		tags,
	},
	{
		description:
			"Adds an environment (production, staging…) with its own callback URLs and authorized origins, and registers its callbacks. A secret only redeems codes sent to its own environment's callbacks.",
		method: "post",
		path: "/oidc-apps/{appId}/environments",
		pathParams: appParam,
		requestBody: createOidcAppEnvironmentApiBody,
		responses: {
			201: { description: "Created", schema: oidcAppEnvironmentResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Add an OIDC app environment",
		tags,
	},
	{
		method: "get",
		path: "/oidc-apps/{appId}/environments/{environmentId}",
		pathParams: environmentParams,
		responses: {
			200: {
				description: "The environment",
				schema: oidcAppEnvironmentResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "Get an OIDC app environment",
		tags,
	},
	{
		description: "Changes the fields sent and keeps the rest.",
		method: "patch",
		path: "/oidc-apps/{appId}/environments/{environmentId}",
		pathParams: environmentParams,
		requestBody: updateOidcAppEnvironmentApiBody,
		responses: {
			200: { description: "Updated", schema: oidcAppEnvironmentResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Update an OIDC app environment",
		tags,
	},
	{
		description:
			"Deletes the environment with its secrets and drops its callbacks, even the app's last one.",
		method: "delete",
		path: "/oidc-apps/{appId}/environments/{environmentId}",
		pathParams: environmentParams,
		responses: { 204: deleted, 401: unauthorized, 404: notFound },
		summary: "Delete an OIDC app environment",
		tags,
	},
	{
		method: "get",
		path: "/oidc-apps/{appId}/secrets",
		pathParams: appParam,
		responses: {
			200: {
				description: "The app's secrets, newest first, never their values",
				isArray: true,
				schema: oidcAppSecretResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "List an OIDC app's secrets",
		tags,
	},
	{
		description:
			"Mints a client secret for one of a confidential app's environments. Its value is only in this response.",
		method: "post",
		path: "/oidc-apps/{appId}/secrets",
		pathParams: appParam,
		requestBody: createOidcAppSecretApiBody,
		responses: {
			201: { description: "Created", schema: createdSecretResponse },
			400: refused,
			401: unauthorized,
			404: notFound,
		},
		summary: "Create an OIDC app secret",
		tags,
	},
	{
		method: "get",
		path: "/oidc-apps/{appId}/secrets/{secretId}",
		pathParams: secretParams,
		responses: {
			200: {
				description: "The secret, without its value",
				schema: oidcAppSecretResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "Get an OIDC app secret",
		tags,
	},
	{
		description: "Revokes the secret: it stops working at once.",
		method: "delete",
		path: "/oidc-apps/{appId}/secrets/{secretId}",
		pathParams: secretParams,
		responses: { 204: deleted, 401: unauthorized, 404: notFound },
		summary: "Revoke an OIDC app secret",
		tags,
	},
];
