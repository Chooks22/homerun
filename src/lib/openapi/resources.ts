import { z } from "zod";
import { DESTINATION_TYPES } from "#lib/backup-destinations.js";
import { CRON_JOB_KINDS, SCRIPT_RUNTIMES } from "#lib/cron-job-script.js";
import { updateStackApiBody } from "#lib/server/validation/api.js";
import {
	backupDestinationApiBody,
	bucketApiBody,
	buildCacheRegistryApiBody,
	cronJobApiBody,
	dnsConnectionApiBody,
	gitProviderApiBody,
	notificationChannelApiBody,
	objectStoreApiBody,
	serviceDependencyApiBody,
	serviceEnvironmentApiBody,
	statusPageApiBody,
	updateBackupDestinationApiBody,
	updateBucketApiBody,
	updateBuildCacheRegistryApiBody,
	updateCronJobApiBody,
	updateDnsConnectionApiBody,
	updateGitProviderApiBody,
	updateNotificationChannelApiBody,
	updateObjectStoreApiBody,
	updateServiceEnvironmentApiBody,
	updateStatusPageApiBody,
	updateVolumeApiBody,
	updateVolumeMountApiBody,
	volumeApiBody,
	volumeMountApiBody,
} from "#lib/server/validation/api-resources.js";
import { volumeResponse } from "./backups";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import { errorResponse, stackResponse, templateResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

const listParams: ParamDef[] = [
	{ description: "1-based page number (default 1)", name: "page" },
	{ description: "Items per page (default 100, max 200)", name: "perPage" },
	{ description: "Case-insensitive search term", name: "q" },
];

const unauthorized: ResponseDef = {
	description: "Unauthorized",
	schema: errorResponse,
};
const notFound: ResponseDef = {
	description: "Not found",
	schema: errorResponse,
};
const invalid: ResponseDef = {
	description: "Invalid body, or a value the instance refuses",
	schema: errorResponse,
};

export const serviceEnvironmentResponse = z.object({
	createdAt: timestamp,
	domain: z.string().nullable(),
	id: z.string().meta({ description: "The environment's own service id" }),
	name: z.string(),
	ref: z.string(),
	serviceId: z.string().meta({ description: "The service it's a copy of" }),
	slug: z.string(),
});

export const serviceDependencyResponse = z.object({
	createdAt: timestamp,
	dependsOnId: z.string(),
	id: z.string(),
	serviceId: z.string(),
});

export const volumeMountResponse = z.object({
	containerPath: z.string(),
	createdAt: timestamp,
	id: z.string(),
	readOnly: z.boolean(),
	serviceId: z.string(),
	volumeId: z.string(),
});

export const cronJobResponse = z.object({
	command: z.string().nullable(),
	createdAt: timestamp,
	description: z.string().nullable(),
	enabled: z.boolean(),
	envVars: z.record(z.string(), z.string()).nullable(),
	files: z.array(z.object({ content: z.string(), path: z.string() })),
	id: z.string(),
	image: z.string().nullable(),
	kind: z.enum(CRON_JOB_KINDS),
	lastRunAt: timestamp.nullable(),
	name: z.string(),
	registryPasswordSet: z.boolean(),
	registryUrl: z.string().nullable(),
	registryUsername: z.string().nullable(),
	remoteHostId: z.string().nullable(),
	runtime: z.enum(SCRIPT_RUNTIMES).nullable(),
	schedule: z.string(),
	source: z.string().nullable(),
	tag: z.string().nullable(),
	timeoutSeconds: z.number().int(),
	updatedAt: timestamp,
	userId: z.string(),
});

export const notificationChannelResponse = z.object({
	createdAt: timestamp,
	enabled: z.boolean(),
	events: z.array(z.string()),
	groupMessages: z.boolean(),
	id: z.string(),
	kind: z.enum(["webhook", "discord", "slack", "telegram", "email", "browser"]),
	lastError: z.string().nullable(),
	name: z.string(),
	targetLabel: z.string().meta({
		description:
			"Where it delivers without the secret part: a webhook's origin, a Telegram chat id, an email address",
	}),
	updatedAt: timestamp,
	userId: z.string(),
});

export const backupDestinationResponse = z.object({
	accessKeyId: z.string(),
	bucket: z.string(),
	createdAt: timestamp,
	endpoint: z.string(),
	id: z.string(),
	name: z.string(),
	region: z.string(),
	secretAccessKeySet: z.boolean(),
	type: z.enum(DESTINATION_TYPES),
	updatedAt: timestamp,
	userId: z.string(),
});

export const statusPageResponse = z.object({
	createdAt: timestamp,
	description: z.string().nullable(),
	domains: z.array(z.string()),
	id: z.string(),
	isPublic: z.boolean(),
	name: z.string(),
	scope: z.enum(["global", "stack", "custom"]),
	services: z.array(
		z.object({ includeChildren: z.boolean(), serviceId: z.string() }),
	),
	slug: z.string(),
	stackId: z.string().nullable(),
	updatedAt: timestamp,
	userId: z.string(),
});

export const dnsConnectionResponse = z.object({
	createdAt: timestamp,
	id: z.string(),
	name: z.string(),
	provider: z.string(),
	providerName: z.string(),
	setFields: z
		.array(z.string())
		.meta({ description: "The credential fields that hold a value" }),
});

export const gitProviderResponse = z.object({
	baseUrl: z.string().nullable(),
	clientId: z.string(),
	clientSecretSet: z.boolean(),
	enabled: z.boolean(),
	id: z.string(),
	kind: z.enum(["github", "gitlab", "gitea", "bitbucket"]),
	name: z.string(),
});

export const buildCacheRegistryResponse = z.object({
	createdAt: timestamp,
	id: z.string(),
	name: z.string(),
	passwordSet: z.boolean(),
	registryUrl: z.string(),
	updatedAt: timestamp,
	userId: z.string(),
	username: z.string(),
});

export const objectStoreResponse = z.object({
	accessKeyId: z.string(),
	createdAt: timestamp,
	endpoint: z.string(),
	id: z.string(),
	kind: z.enum(["s3", "garage"]),
	name: z.string(),
	region: z.string(),
});

export const bucketResponse = z.object({
	expirationDays: z.number().int().nullable(),
	id: z.string().meta({ description: "<storeId>/<name>" }),
	name: z.string(),
	public: z.boolean(),
	storeId: z.string(),
});

interface CrudSpec {
	createBody?: z.ZodType;
	idParam: ParamDef;
	/** Lines added to each operation's description, by method. */
	notes?: Partial<Record<"create" | "delete" | "list" | "update", string>>;
	noun: string;
	paginated?: boolean;
	parentParams?: ParamDef[];
	path: string;
	plural: string;
	response: z.ZodType;
	tag: string;
	updateBody?: z.ZodType;
}

/** The list, create, get, update and delete operations of one REST resource. */
function crudRoutes(spec: CrudSpec): RouteDef[] {
	const item = `${spec.path}/{${spec.idParam.name}}`;
	const parent = spec.parentParams ?? [];
	const guard: Record<number, ResponseDef> = { 401: unauthorized };
	const base = { tags: [spec.tag] };
	const routes: RouteDef[] = [
		{
			...base,
			description: spec.paginated
				? "Paginated: the body is the page, x-total-count, x-page and x-per-page carry the rest."
				: `Every ${spec.noun}, in one response.`,
			method: "get",
			path: spec.path,
			pathParams: parent.length > 0 ? parent : undefined,
			queryParams: spec.paginated ? listParams : undefined,
			responses: {
				200: {
					description: `The ${spec.plural}`,
					isArray: true,
					schema: spec.response,
				},
				...guard,
			},
			summary: `List ${spec.plural}`,
		},
		{
			...base,
			method: "get",
			path: item,
			pathParams: [...parent, spec.idParam],
			responses: {
				200: { description: `The ${spec.noun}`, schema: spec.response },
				...guard,
				404: notFound,
			},
			summary: `Get a ${spec.noun}`,
		},
		{
			...base,
			description: spec.notes?.delete,
			method: "delete",
			path: item,
			pathParams: [...parent, spec.idParam],
			responses: { 204: { description: "Deleted" }, ...guard, 404: notFound },
			summary: `Delete a ${spec.noun}`,
		},
	];
	if (spec.createBody) {
		routes.push({
			...base,
			description: spec.notes?.create,
			method: "post",
			path: spec.path,
			pathParams: parent.length > 0 ? parent : undefined,
			requestBody: spec.createBody,
			responses: {
				201: { description: "Created", schema: spec.response },
				400: invalid,
				...guard,
			},
			summary: `Create a ${spec.noun}`,
		});
	}
	if (spec.updateBody) {
		routes.push({
			...base,
			description:
				spec.notes?.update ?? "Changes the fields sent and keeps the rest.",
			method: "patch",
			path: item,
			pathParams: [...parent, spec.idParam],
			requestBody: spec.updateBody,
			responses: {
				200: { description: "Updated", schema: spec.response },
				400: invalid,
				...guard,
				404: notFound,
			},
			summary: `Update a ${spec.noun}`,
		});
	}
	return routes;
}

const stackItem = crudRoutes({
	idParam: { description: "Stack id", name: "stackId" },
	notes: {
		delete:
			"Removes every service in it and the stack itself. A member with a queued or running job (a deploy mid-flight), or a workload that can't be removed, answers 409 unless ?force=true, which cancels those jobs and deletes anyway. ?deleteVolumes=true also deletes the volumes no service outside the stack mounts.",
	},
	noun: "stack",
	path: "/stacks",
	plural: "stacks",
	response: stackResponse,
	tag: "Stacks",
	updateBody: updateStackApiBody,
}).filter((route) => route.path !== "/stacks");

const volumeRoutes = crudRoutes({
	createBody: volumeApiBody,
	idParam: { description: "Volume id", name: "volumeId" },
	notes: {
		delete: "Deletes the volume's record and its mounts, not the data.",
		update:
			"Changes the fields sent and keeps the rest. Turning backups on without a schedule picks 0 3 * * *.",
	},
	noun: "volume",
	path: "/volumes",
	plural: "volumes",
	response: volumeResponse,
	tag: "Backups",
	updateBody: updateVolumeApiBody,
}).filter((route) => !(route.path === "/volumes" && route.method === "get"));

export const resourceRoutes: RouteDef[] = [
	...stackItem,
	{
		method: "get",
		path: "/templates/{templateId}",
		pathParams: [{ description: "Template id", name: "templateId" }],
		responses: {
			200: { description: "The template", schema: templateResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a template",
		tags: ["Templates"],
	},
	...crudRoutes({
		createBody: serviceEnvironmentApiBody,
		idParam: { description: "Environment id", name: "environmentId" },
		notes: {
			create:
				"Copies the service (settings, variables, volumes) into one running ref, under its own slug.",
			update:
				"Points the environment at another ref or main domain, and sets envOverrides over its variables. Doesn't deploy.",
		},
		noun: "service environment",
		path: "/service-environments",
		plural: "service environments",
		response: serviceEnvironmentResponse,
		tag: "Services",
		updateBody: updateServiceEnvironmentApiBody,
	}),
	...crudRoutes({
		createBody: serviceDependencyApiBody,
		idParam: { description: "Dependency id", name: "dependencyId" },
		notes: { create: "Refused when it would make a loop." },
		noun: "service dependency",
		path: "/service-dependencies",
		plural: "service dependencies",
		response: serviceDependencyResponse,
		tag: "Services",
	}),
	...volumeRoutes,
	...crudRoutes({
		createBody: volumeMountApiBody,
		idParam: { description: "Mount id", name: "mountId" },
		notes: { create: "Applied on the service's next deploy." },
		noun: "volume mount",
		path: "/volume-mounts",
		plural: "volume mounts",
		response: volumeMountResponse,
		tag: "Backups",
		updateBody: updateVolumeMountApiBody,
	}),
	...crudRoutes({
		createBody: cronJobApiBody,
		idParam: { description: "Cron job id", name: "cronJobId" },
		notes: { create: "A kind exec job (a host command) needs an admin." },
		noun: "cron job",
		paginated: true,
		path: "/cron-jobs",
		plural: "cron jobs",
		response: cronJobResponse,
		tag: "Cron jobs",
		updateBody: updateCronJobApiBody,
	}),
	...crudRoutes({
		createBody: notificationChannelApiBody,
		idParam: { description: "Channel id", name: "channelId" },
		noun: "notification channel",
		path: "/notification-channels",
		plural: "notification channels of the caller",
		response: notificationChannelResponse,
		tag: "Notifications",
		updateBody: updateNotificationChannelApiBody,
	}),
	...crudRoutes({
		createBody: backupDestinationApiBody,
		idParam: { description: "Destination id", name: "destinationId" },
		noun: "backup destination",
		paginated: true,
		path: "/backup-destinations",
		plural: "backup destinations",
		response: backupDestinationResponse,
		tag: "Backups",
		updateBody: updateBackupDestinationApiBody,
	}),
	...crudRoutes({
		createBody: statusPageApiBody,
		idParam: { description: "Status page id", name: "statusPageId" },
		noun: "status page",
		path: "/status-pages",
		plural: "status pages",
		response: statusPageResponse,
		tag: "Status pages",
		updateBody: updateStatusPageApiBody,
	}),
	...crudRoutes({
		createBody: dnsConnectionApiBody,
		idParam: { description: "Connection id", name: "connectionId" },
		notes: {
			update:
				"Renames the connection and replaces the credential fields sent; the others keep their stored value.",
		},
		noun: "DNS connection",
		path: "/dns-connections",
		plural: "DNS connections",
		response: dnsConnectionResponse,
		tag: "DNS",
		updateBody: updateDnsConnectionApiBody,
	}),
	...crudRoutes({
		createBody: gitProviderApiBody,
		idParam: { description: "Provider id", name: "providerId" },
		notes: {
			create:
				"GitLab, Gitea or Bitbucket OAuth apps. GitHub Apps are registered from the dashboard's Git Providers page.",
		},
		noun: "git provider",
		path: "/git-providers",
		plural: "git providers",
		response: gitProviderResponse,
		tag: "Git providers",
		updateBody: updateGitProviderApiBody,
	}),
	...crudRoutes({
		createBody: buildCacheRegistryApiBody,
		idParam: { description: "Registry id", name: "registryId" },
		noun: "build cache registry",
		paginated: true,
		path: "/build-cache-registries",
		plural: "build cache registries",
		response: buildCacheRegistryResponse,
		tag: "Builds",
		updateBody: updateBuildCacheRegistryApiBody,
	}),
	...crudRoutes({
		createBody: objectStoreApiBody,
		idParam: { description: "Store id", name: "storeId" },
		notes: {
			create: "Saved once listing buckets with the credentials works.",
			delete:
				"Deletes the store's record and its Terraform state projects, not its buckets. The built-in store answers 409.",
		},
		noun: "object store",
		path: "/object-stores",
		plural: "object stores",
		response: objectStoreResponse,
		tag: "Object storage",
		updateBody: updateObjectStoreApiBody,
	}),
	...crudRoutes({
		createBody: bucketApiBody,
		idParam: { description: "Bucket name", name: "bucket" },
		notes: { delete: "Only an empty bucket can be deleted." },
		noun: "bucket",
		parentParams: [{ description: "Store id", name: "storeId" }],
		path: "/object-stores/{storeId}/buckets",
		plural: "buckets of a store",
		response: bucketResponse,
		tag: "Object storage",
		updateBody: updateBucketApiBody,
	}),
];
