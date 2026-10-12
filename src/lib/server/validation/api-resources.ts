import { z } from "zod";
import { DESTINATION_TYPES } from "#lib/backup-destinations.js";
import { CRON_JOB_KINDS, SCRIPT_RUNTIMES } from "#lib/cron-job-script.js";
import { isNotificationEvent } from "#lib/notification-events.js";

const text = z.string().trim();
const nullableText = text.nullable().optional();
const schedule = text.min(1).describe("5-field cron expression.");
const secret = (description: string) =>
	z.string().trim().min(1).describe(`${description} Write-only.`);

export const serviceEnvironmentApiBody = z.object({
	deploy: z
		.boolean()
		.default(false)
		.describe("Queue the environment's first deploy right away."),
	domain: text.toLowerCase().nullable().optional(),
	envOverrides: z
		.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
		.default({})
		.describe(
			"Variables set on top of the ones copied from the service. Write-only.",
		),
	name: text.toLowerCase().min(1).describe("e.g. staging"),
	ref: text
		.min(1)
		.describe("The branch or tag (git service) or image tag it runs."),
	serviceId: z.string().min(1),
});

export const updateServiceEnvironmentApiBody = serviceEnvironmentApiBody
	.omit({ deploy: true, name: true, serviceId: true })
	.extend({ envOverrides: serviceEnvironmentApiBody.shape.envOverrides })
	.partial();

export const serviceDependencyApiBody = z.object({
	dependsOnId: z.string().min(1).describe("The service it depends on."),
	serviceId: z.string().min(1).describe("The service that depends on it."),
});

const volumeBackupFields = {
	backupEnabled: z.boolean().optional(),
	backupPreCommand: nullableText.describe(
		"A command run in backupPreCommandServiceId before each backup.",
	),
	backupPreCommandServiceId: z.string().nullable().optional(),
	backupPrefix: nullableText,
	backupSchedule: nullableText.describe("5-field cron expression."),
	backupStopServices: z
		.boolean()
		.optional()
		.describe("Stop the services using the volume during a backup."),
	s3DestinationId: z.string().nullable().optional(),
};

export const volumeApiBody = z.object({
	description: nullableText,
	kind: z.enum(["bind", "volume"]),
	name: text.min(1).max(100),
	source: text
		.min(1)
		.describe("An absolute host path (bind) or a Docker volume name."),
	...volumeBackupFields,
});

export const updateVolumeApiBody = z.object({
	description: nullableText,
	name: text.min(1).max(100).optional(),
	...volumeBackupFields,
});

export const volumeMountApiBody = z.object({
	containerPath: text.regex(/^\//, "The mount path must be absolute."),
	readOnly: z.boolean().default(false),
	serviceId: z.string().min(1),
	volumeId: z.string().min(1),
});

export const updateVolumeMountApiBody = volumeMountApiBody
	.pick({ containerPath: true })
	.extend({ readOnly: z.boolean() })
	.partial();

const cronJobFile = z.object({
	content: z.string(),
	path: text.min(1).describe("Absolute path inside the container."),
});

export const cronJobApiBody = z.object({
	command: nullableText,
	description: nullableText,
	enabled: z.boolean().default(false),
	envVars: z.record(z.string(), z.string()).default({}),
	files: z
		.array(cronJobFile)
		.default([])
		.describe(
			"Text files written into the container before it starts. Ignored for exec.",
		),
	image: nullableText,
	kind: z
		.enum(CRON_JOB_KINDS)
		.describe(
			"image (a container), script (source code on a runtime image) or exec (a host command, needs write access to System).",
		),
	name: text.min(1).max(100),
	registryPassword: secret("Registry password.").optional(),
	registryUrl: nullableText,
	registryUsername: nullableText,
	remoteHostId: z.string().nullable().optional(),
	runtime: z
		.enum(SCRIPT_RUNTIMES)
		.nullable()
		.optional()
		.describe("The runtime a script job's source runs on."),
	schedule,
	source: z
		.string()
		.nullable()
		.optional()
		.describe("A script job's source code."),
	tag: nullableText,
	timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
});

export const updateCronJobApiBody = cronJobApiBody
	.omit({ kind: true })
	.extend({
		enabled: z.boolean(),
		envVars: z.record(z.string(), z.string()),
		files: z.array(cronJobFile),
	})
	.partial();

const notificationEvents = z
	.array(z.string())
	.refine((events) => events.every(isNotificationEvent), {
		error: "Unknown notification event.",
	})
	.describe("The events sent to the channel.");

export const notificationChannelApiBody = z.object({
	enabled: z.boolean().optional(),
	events: notificationEvents.optional(),
	groupMessages: z
		.boolean()
		.optional()
		.describe(
			"Fold notifications sent less than a minute apart into one message.",
		),
	kind: z.enum(["webhook", "discord", "slack", "telegram", "email"]),
	name: text.min(1).max(100),
	target: secret(
		"The webhook URL, the email address, or bot_token:chat_id for Telegram.",
	),
});

export const updateNotificationChannelApiBody = notificationChannelApiBody
	.omit({ kind: true })
	.partial();

export const backupDestinationApiBody = z.object({
	accessKeyId: text.min(1).describe("Access key id, or username."),
	bucket: text.default("").describe("Bucket, or path (share for smb)."),
	endpoint: text.min(1).describe("S3 endpoint URL, or host / WebDAV URL."),
	name: text.min(1).max(100),
	region: text.default(""),
	secretAccessKey: secret("Secret access key, password, or SFTP private key."),
	type: z.enum(DESTINATION_TYPES).default("s3"),
});

export const updateBackupDestinationApiBody = z
	.object({
		accessKeyId: text.min(1),
		bucket: text,
		endpoint: text.min(1),
		name: text.min(1).max(100),
		region: text,
		secretAccessKey: secret("Secret access key, password or private key."),
	})
	.partial();

const statusPageServices = z
	.array(
		z.object({
			includeChildren: z.boolean().default(false),
			serviceId: z.string().min(1),
		}),
	)
	.describe("The services a custom-scope page shows.");

export const statusPageApiBody = z.object({
	description: nullableText,
	domains: z
		.array(z.string())
		.optional()
		.describe(
			"Domains a public page also answers on, e.g. status.example.com: Traefik routes them to the page, with TLS and DNS like a service's.",
		),
	isPublic: z.boolean().default(false),
	name: text.min(1).max(100),
	scope: z.enum(["global", "stack", "custom"]),
	services: statusPageServices.default([]),
	slug: text
		.min(1)
		.max(60)
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			"Lowercase letters, numbers and dashes only.",
		),
	stackId: z.string().nullable().optional(),
});

export const updateStatusPageApiBody = statusPageApiBody
	.extend({ isPublic: z.boolean(), services: statusPageServices })
	.partial();

export const dnsConnectionApiBody = z.object({
	credentials: z
		.record(z.string(), z.string())
		.describe("The provider's credential fields by key. Write-only."),
	name: text.max(100).optional(),
	provider: z.string().min(1).describe("The DNS provider's id."),
});

export const updateDnsConnectionApiBody = dnsConnectionApiBody
	.omit({ provider: true })
	.partial();

export const gitProviderApiBody = z.object({
	baseUrl: nullableText.describe("Required for Gitea (self-hosted only)."),
	clientId: text.min(1),
	clientSecret: secret("OAuth client secret."),
	enabled: z.boolean().default(true),
	kind: z.enum(["gitlab", "gitea", "bitbucket"]),
	name: text.min(1).max(100),
});

export const updateGitProviderApiBody = gitProviderApiBody
	.omit({ kind: true })
	.extend({ enabled: z.boolean() })
	.partial();

export const buildCacheRegistryApiBody = z.object({
	name: text.min(1).max(100),
	password: secret("Registry password."),
	registryUrl: text.min(1).describe("e.g. ghcr.io, without a scheme."),
	username: text.min(1),
});

export const updateBuildCacheRegistryApiBody =
	buildCacheRegistryApiBody.partial();

export const objectStoreApiBody = z.object({
	accessKeyId: text.min(1),
	endpoint: text.min(1).describe("The S3 endpoint URL."),
	name: text.min(1).max(100),
	region: text.default("us-east-1"),
	secretAccessKey: secret("Secret access key."),
});

export const updateObjectStoreApiBody = objectStoreApiBody
	.extend({ region: text.min(1) })
	.partial();

const expirationDays = z
	.number()
	.int()
	.min(1)
	.max(36_500)
	.nullable()
	.describe("Delete objects this many days after they're written, null never.");

const isPublic = z
	.boolean()
	.describe(
		"Serve the bucket's objects to anyone at /public/<storeId>/<bucket>/<key>, without signing in.",
	);

export const bucketApiBody = z.object({
	expirationDays: expirationDays.optional(),
	name: text.min(1),
	public: isPublic.optional(),
});

export const updateBucketApiBody = z.object({
	expirationDays: expirationDays.optional(),
	public: isPublic.optional(),
});
