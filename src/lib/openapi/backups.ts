import { z } from "zod";
import type { ParamDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

const listParams: ParamDef[] = [
	{ description: "1-based page number (default 1)", name: "page" },
	{ description: "Items per page (default 100, max 200)", name: "perPage" },
	{ description: "Case-insensitive search term", name: "q" },
];

export const backupRunResponse = z.object({
	error: z.string().nullable(),
	finishedAt: timestamp.nullable(),
	id: z.string(),
	jobAttempts: z.number().int().nullable().meta({
		description: "How many times its job has been claimed",
	}),
	jobId: z.string().nullable().meta({
		description: "The queue job running it, GET /jobs/{jobId} has its log",
	}),
	jobProgressAt: timestamp.nullable().meta({
		description:
			"The last time its job moved a byte or got a Docker answer; a running backup whose progressAt stops moving is stuck",
	}),
	jobStatus: z
		.enum(["queued", "running", "succeeded", "failed", "cancelled"])
		.nullable(),
	key: z
		.string()
		.nullable()
		.meta({ description: "The object key in the bucket" }),
	kind: z.enum(["backup", "restore"]),
	sizeBytes: z.number().int().nullable(),
	startedAt: timestamp,
	success: z.boolean().nullable().meta({ description: "null while running" }),
	volumeId: z.string(),
	volumeName: z.string(),
});

export const volumeResponse = z.object({
	backupEnabled: z.boolean(),
	backupLastRunAt: timestamp.nullable(),
	backupNextRunAt: timestamp.nullable().meta({
		description: "When the schedule fires next, null when backups are off",
	}),
	backupPreCommand: z.string().nullable(),
	backupPreCommandServiceId: z.string().nullable(),
	backupPrefix: z.string().nullable(),
	backupSchedule: z
		.string()
		.nullable()
		.meta({ description: "Cron expression" }),
	backupStopServices: z.boolean(),
	createdAt: timestamp,
	description: z.string().nullable(),
	id: z.string(),
	kind: z.enum(["bind", "volume"]),
	name: z.string(),
	s3DestinationId: z.string().nullable(),
	source: z.string().meta({
		description: "A host path for a bind, the Docker volume name otherwise",
	}),
	updatedAt: timestamp,
	userId: z.string(),
});

export const backupRoutes: RouteDef[] = [
	{
		description:
			"Every backup and restore run across volumes, newest first, with its job's status and last progress. Paginated: the body is the page, x-total-count, x-page and x-per-page carry the rest.",
		method: "get",
		path: "/backups",
		queryParams: [
			...listParams,
			{ description: "Comma-separated volume ids", name: "volume" },
			{
				description: "Comma-separated outcomes: running, success, failed",
				name: "outcome",
			},
			{ description: "Comma-separated kinds: backup, restore", name: "kind" },
		],
		responses: {
			200: {
				description: "One page of runs",
				isArray: true,
				schema: backupRunResponse,
			},
			401: { description: "Unauthorized", schema: errorResponse },
		},
		summary: "List backup runs",
		tags: ["Backups"],
	},
	{
		description:
			"Storage volumes with their backup settings. Paginated like the other lists.",
		method: "get",
		path: "/volumes",
		queryParams: [
			...listParams,
			{
				description: "on or off: only volumes with backups on/off",
				name: "backup",
			},
			{ description: "Comma-separated kinds: bind, volume", name: "kind" },
		],
		responses: {
			200: {
				description: "One page of volumes",
				isArray: true,
				schema: volumeResponse,
			},
			401: { description: "Unauthorized", schema: errorResponse },
		},
		summary: "List storage volumes",
		tags: ["Backups"],
	},
	{
		description:
			"Queues a backup of the volume, like its Run now button. A backup already queued for it is returned instead of a second one. Follow it with GET /jobs/{jobId} or GET /backups?volume={volumeId}.",
		method: "post",
		path: "/volumes/{volumeId}/backup",
		pathParams: [{ description: "Volume id", name: "volumeId" }],
		responses: {
			202: {
				description: "Queued",
				schema: z.object({ jobId: z.string() }),
			},
			400: {
				description: "The volume has no backup destination",
				schema: errorResponse,
			},
			401: { description: "Unauthorized", schema: errorResponse },
			404: { description: "Not found", schema: errorResponse },
		},
		summary: "Back up a volume now",
		tags: ["Backups"],
	},
];
