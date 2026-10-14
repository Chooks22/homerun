import { z } from "zod";
import { PERMISSION_AREAS, PERMISSION_LEVELS } from "#lib/permissions.js";
import {
	createServiceAccountApiBody,
	createServiceAccountKeyApiBody,
	updateServiceAccountApiBody,
} from "#lib/server/validation/api.js";
import type { ParamDef, RouteDef } from "./registry";
import { errorResponse, successResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

const accountIdParam: ParamDef[] = [
	{ description: "Service account id", name: "accountId" },
];

export const serviceAccountResponse = z.object({
	createdAt: timestamp,
	disabled: z.boolean(),
	id: z.string().meta({
		description:
			"The id to put in a login wall's allowed users (authAllowedUserIds, previewAuthAllowedUserIds)",
	}),
	name: z.string(),
	permissions: z.partialRecord(
		z.enum(PERMISSION_AREAS.map((area) => area.key)),
		z.enum(PERMISSION_LEVELS),
	),
	updatedAt: timestamp,
});

export const serviceAccountKeyResponse = z.object({
	createdAt: timestamp,
	expiresAt: timestamp.nullable(),
	id: z.string(),
	lastRequest: timestamp.nullable(),
	name: z.string().nullable(),
	prefix: z.string().nullable(),
	start: z.string().nullable().meta({
		description: "The first characters of the key, to tell keys apart",
	}),
});

export const createdServiceAccountKeyResponse = z.object({
	expiresAt: timestamp.nullable(),
	id: z.string(),
	key: z.string().meta({
		description: "The secret. It's only ever returned here, store it now.",
	}),
	name: z.string().nullable(),
});

export const auditLogEntryResponse = z.object({
	action: z.string().meta({
		description:
			'"gate.handshake" for a login-wall sign-in, "api.request" for anything else',
	}),
	actorId: z.string().nullable(),
	actorName: z.string(),
	createdAt: timestamp,
	detail: z.string(),
	id: z.string(),
	ipAddress: z.string().nullable(),
	status: z.number().nullable(),
});

const unauthorized = { description: "Unauthorized", schema: errorResponse };
const notFound = { description: "Not found", schema: errorResponse };
const invalid = { description: "Invalid body", schema: errorResponse };
const tags = ["Service accounts"];

export const serviceAccountRoutes: RouteDef[] = [
	{
		description:
			"Every service account: a non-human user with no sign-in method, whose API keys get through the login walls that list it, plus the areas it was granted.",
		method: "get",
		path: "/service-accounts",
		responses: {
			200: {
				description: "The service accounts",
				isArray: true,
				schema: serviceAccountResponse,
			},
			401: unauthorized,
		},
		summary: "List service accounts",
		tags,
	},
	{
		description:
			"Creates an enabled service account. permissions default to none and are cut down to what the caller holds.",
		method: "post",
		path: "/service-accounts",
		requestBody: createServiceAccountApiBody,
		responses: {
			201: { description: "Created", schema: serviceAccountResponse },
			400: invalid,
			401: unauthorized,
		},
		summary: "Create a service account",
		tags,
	},
	{
		method: "get",
		path: "/service-accounts/{accountId}",
		pathParams: accountIdParam,
		responses: {
			200: {
				description: "The service account",
				schema: serviceAccountResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a service account",
		tags,
	},
	{
		description:
			'Changes the fields sent, keeping the rest. Send {"disabled": true} to refuse its keys without deleting it.',
		method: "patch",
		path: "/service-accounts/{accountId}",
		pathParams: accountIdParam,
		requestBody: updateServiceAccountApiBody,
		responses: {
			200: { description: "Updated", schema: serviceAccountResponse },
			400: invalid,
			401: unauthorized,
			404: notFound,
		},
		summary: "Update a service account",
		tags,
	},
	{
		description:
			"Deletes the account and its keys. Anything it created is handed over to the caller; its audit log entries stay.",
		method: "delete",
		path: "/service-accounts/{accountId}",
		pathParams: accountIdParam,
		responses: {
			200: { description: "Deleted", schema: successResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Delete a service account",
		tags,
	},
	{
		description:
			"The latest 200 uses of the account's keys, newest first: login-wall handshakes and API requests, refused ones included.",
		method: "get",
		path: "/service-accounts/{accountId}/activity",
		pathParams: accountIdParam,
		responses: {
			200: {
				description: "The account's audit log",
				isArray: true,
				schema: auditLogEntryResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "List a service account's activity",
		tags,
	},
	{
		method: "get",
		path: "/service-accounts/{accountId}/keys",
		pathParams: accountIdParam,
		responses: {
			200: {
				description: "The account's keys, newest first, without their secrets",
				isArray: true,
				schema: serviceAccountKeyResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "List a service account's API keys",
		tags,
	},
	{
		description:
			"Mints an API key for the account. The key does whatever the account may do; the secret is in this response only.",
		method: "post",
		path: "/service-accounts/{accountId}/keys",
		pathParams: accountIdParam,
		requestBody: createServiceAccountKeyApiBody,
		requestBodyOptional: true,
		responses: {
			201: {
				description: "Created",
				schema: createdServiceAccountKeyResponse,
			},
			400: invalid,
			401: unauthorized,
			404: notFound,
		},
		summary: "Create a service account API key",
		tags,
	},
	{
		method: "delete",
		path: "/service-accounts/{accountId}/keys/{keyId}",
		pathParams: [
			...accountIdParam,
			{ description: "API key id", name: "keyId" },
		],
		responses: {
			200: { description: "Revoked", schema: successResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Revoke a service account API key",
		tags,
	},
];
