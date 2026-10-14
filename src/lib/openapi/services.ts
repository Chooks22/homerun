import { z } from "zod";
import {
	createServiceApiBody,
	createServiceFromTemplateApiBody,
	updateServiceApiBody,
} from "#lib/server/validation/api.js";
import { serviceConfigSchema } from "#lib/service-config.js";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import {
	domainConflictResponse,
	errorResponse,
	serviceResponse,
} from "./schemas";

const listQueryParams: ParamDef[] = [
	{ description: "1-based page number (default 1)", name: "page" },
	{
		description: "Items per page (default 100, max 200)",
		name: "perPage",
	},
	{ description: "Case-insensitive search term", name: "q" },
];

const notFound: ResponseDef = {
	description: "Not found",
	schema: errorResponse,
};
const unauthorized: ResponseDef = {
	description: "Unauthorized",
	schema: errorResponse,
};
const badRequest: ResponseDef = {
	description: "Invalid request body",
	schema: errorResponse,
};

/** The services collection and a service's own record: list, create, read, read by tab, update, delete. */
export const serviceRoutes: RouteDef[] = [
	{
		description:
			"Paginated. The response body is the page's items; the total row count, current page and page size come back in the x-total-count, x-page and x-per-page headers.",
		method: "get",
		path: "/services",
		queryParams: listQueryParams,
		responses: {
			200: {
				description: "Every service on the instance",
				isArray: true,
				schema: serviceResponse,
			},
			401: unauthorized,
		},
		summary: "List services",
		tags: ["Services"],
	},
	{
		description:
			"Persists config only : does not deploy. Call POST /services/{serviceId}/deploy afterward to actually pull/build and start it. Any setting PATCH takes may be sent too. With templateId, the service (and the template's linked services) is created from the template first.",
		method: "post",
		path: "/services",
		requestBody: z.union([
			createServiceApiBody,
			createServiceFromTemplateApiBody,
		]),
		responses: {
			201: { description: "Created", schema: serviceResponse },
			400: badRequest,
			401: unauthorized,
			409: {
				description:
					"Slug already in use, the instance is full, or a domain is already routed elsewhere (conflicts lists each one with its owner; nothing is created)",
				schema: domainConflictResponse,
			},
		},
		summary: "Create a service",
		tags: ["Services"],
	},
	{
		method: "get",
		path: "/services/{serviceId}",
		pathParams: [{ description: "Service id", name: "serviceId" }],
		responses: {
			200: { description: "The service", schema: serviceResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a service",
		tags: ["Services"],
	},
	{
		description:
			"The service's settings grouped the way the dashboard's tabs group them (source, env, volumes, networking, compute, runtime, security, settings). Secrets are never included: a stored registry password or SSL key shows as a boolean, and an uploaded icon as \"uploaded\".",
		method: "get",
		path: "/services/{serviceId}/config",
		pathParams: [{ description: "Service id", name: "serviceId" }],
		responses: {
			200: {
				description: "The service's settings",
				schema: serviceConfigSchema,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a service's settings, by tab",
		tags: ["Services"],
	},
	{
		method: "patch",
		path: "/services/{serviceId}",
		pathParams: [{ description: "Service id", name: "serviceId" }],
		requestBody: updateServiceApiBody,
		responses: {
			200: { description: "Updated", schema: serviceResponse },
			400: badRequest,
			401: unauthorized,
			404: notFound,
			409: {
				description:
					"Slug already in use, or a domain the change adds is already routed elsewhere: conflicts lists each one with its owner, and when canTakeOver is true the same body with takeOverDomains: true moves them here. Nothing is saved.",
				schema: domainConflictResponse,
			},
		},
		summary: "Update a service (partial)",
		tags: ["Services"],
	},
	{
		description:
			"Removes the container or swarm service first, same as the Settings danger-zone action. One Docker reports as already gone counts as removed. A queued or running job for the service or one of its previews, environments or canary (a deploy mid-flight), or any other removal failure, answers 409 and deletes nothing, unless force=true.",
		method: "delete",
		path: "/services/{serviceId}",
		pathParams: [{ description: "Service id", name: "serviceId" }],
		queryParams: [
			{
				description:
					"true cancels the service's queued and running jobs instead of refusing, and deletes the service record even when its container or swarm service couldn't be removed",
				name: "force",
			},
			{
				description:
					"true also deletes the volumes no other service mounts: the record, and the Docker volume behind a named one (a bind mount's host directory is left alone)",
				name: "deleteVolumes",
			},
		],
		responses: {
			204: { description: "Deleted" },
			401: unauthorized,
			404: notFound,
			409: {
				description:
					"A job is still queued or running for it, or the container or swarm service couldn't be removed; nothing was deleted",
				schema: errorResponse,
			},
		},
		summary: "Delete a service",
		tags: ["Services"],
	},
];
