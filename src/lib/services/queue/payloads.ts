import { z } from "zod";
import { DEPLOY_TRIGGERS } from "#lib/deploy-trigger.js";
import { isNotificationEvent } from "#lib/notification-events.js";
import type { NotificationEvent } from "#lib/types.js";

export const deployJobPayload = z.object({
	deploymentId: z.string(),
	mountSwap: z.object({ from: z.string(), to: z.string() }).optional(),
	noCache: z.boolean().default(false),
	serviceId: z.string(),
	trigger: z.enum(DEPLOY_TRIGGERS).default("manual"),
	userId: z.string(),
});

export const cronJobPayload = z.object({
	cronJobId: z.string(),
	scheduled: z.boolean().default(false),
	userId: z.string(),
});

export const imageScanJobPayload = z.object({
	serviceId: z.string(),
	userId: z.string(),
});

export const backupJobPayload = z.object({
	scheduled: z.boolean().default(false),
	userId: z.string(),
	volumeId: z.string(),
});

export const backupRestoreJobPayload = z.object({
	key: z.string().min(1),
	stopServices: z.boolean().default(false),
	userId: z.string(),
	volumeId: z.string(),
	wipe: z.boolean().default(false),
});

export const coreServiceJobPayload = z.discriminatedUnion("action", [
	z.object({ action: z.literal("enableBuiltinStore"), userId: z.string() }),
	z.object({ action: z.literal("disableBuiltinStore") }),
	z.object({ action: z.literal("publishBuiltinStore"), host: z.string() }),
	z.object({ action: z.literal("setRegistryAuth"), enabled: z.boolean() }),
	z.object({ action: z.literal("publishRegistry"), host: z.string() }),
]);

export type CoreServiceJob = z.infer<typeof coreServiceJobPayload>;

export const dockerCleanupActions = [
	"reclaimStackNetworks",
	"pruneBuildCache",
	"pruneContainers",
	"pruneImages",
	"pruneMirror",
	"pruneNetworks",
	"pruneSystem",
	"pruneVolumes",
] as const;

export const dockerCleanupJobPayload = z.object({
	action: z.enum(dockerCleanupActions),
	all: z.boolean().default(false),
});

export const notificationDeliveryJobPayload = z.object({
	channelId: z.string(),
	message: z.object({
		detail: z.string().nullable(),
		event: z.custom<NotificationEvent>(
			(value) => typeof value === "string" && isNotificationEvent(value),
		),
		fields: z.array(z.object({ name: z.string(), value: z.string() })),
		link: z.string().nullable(),
		serviceId: z.string(),
		serviceName: z.string(),
		timestamp: z.string(),
		title: z.string(),
	}),
});

export type DockerCleanupAction = (typeof dockerCleanupActions)[number];

export const pipelineSyncJobPayload = z.object({
	repositoryId: z.string(),
});
