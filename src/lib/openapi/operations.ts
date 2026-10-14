import { z } from "zod";
import { MONITORING_RANGES } from "#lib/monitoring-ranges.js";
import {
	dockerCleanupApiBody,
	servicePinApiBody,
	serviceVersionWatchApiBody,
} from "#lib/server/validation/operations-api.js";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });

export const serviceVersionResponse = z.object({
	availableDigest: z.string().nullable(),
	availableFoundAt: timestamp.nullable(),
	availableTag: z.string().nullable().meta({
		description:
			"The update the last check found: a newer release, or the same floating tag with a new image. Null when up to date or never checked",
	}),
	checkError: z.string().nullable().meta({
		description: "Why the last check couldn't read the registry",
	}),
	checkedAt: timestamp.nullable(),
	id: z.string().meta({ description: "The service's id" }),
	image: z.string(),
	pinned: z.boolean(),
	pinnedFromTag: z.string().nullable().meta({
		description: "The floating tag unpinning goes back to",
	}),
	pinnedLocally: z.boolean().meta({
		description: "The pinned tag was made on this host from the running image",
	}),
	tag: z.string(),
	trialAt: timestamp.nullable(),
	trialMessage: z.string().nullable().meta({
		description:
			"How the trial passed, or why it failed with its last log lines",
	}),
	trialStatus: z.enum(["running", "passed", "failed"]).nullable(),
	trialTag: z.string().nullable(),
	updateCheckEnabled: z.boolean(),
	updateTrialEnabled: z.boolean(),
});

export const pinCandidatesResponse = z.object({
	digest: z.string().nullable().meta({
		description: "The digest of the image the service runs, null when unknown",
	}),
	matches: z.array(z.string()).meta({
		description: "Registry tags published for exactly that image",
	}),
	suggestion: z.string().meta({
		description:
			"A tag to make on this host when no registry tag matches: the image's version label, or the current tag stamped with today's date",
	}),
});

const availability = z.object({
	avgLatencyMs: z.number().nullable(),
	checks: z.number().int(),
	ok: z.number().int(),
});

const trafficTotals = z.object({
	avgResponseMs: z.number().nullable(),
	bytesIn: z.number(),
	bytesOut: z.number(),
	requests: z.number().int(),
	status4xx: z.number().int(),
	status5xx: z.number().int(),
});

const resourceTotals = z.object({
	avgCpuPercent: z.number().nullable(),
	avgMemUsedMb: z.number().nullable(),
	memLimitMb: z.number().nullable(),
	peakCpuPercent: z.number().nullable(),
	peakMemUsedMb: z.number().nullable(),
});

const monitoringTotals = {
	availability: z.object({ external: availability, internal: availability }),
	previous: z
		.object({
			availability: z.object({
				external: availability,
				internal: availability,
			}),
			label: z.string(),
			resources: resourceTotals,
			traffic: trafficTotals,
		})
		.nullable()
		.meta({ description: "The previous period's totals, null for all time" }),
	range: z.enum(MONITORING_RANGES.map((range) => range.id)),
	resources: resourceTotals.meta({
		description: "Average and peak CPU and memory over the range",
	}),
	since: timestamp.nullable(),
	spanSeconds: z.number(),
	traffic: trafficTotals.meta({
		description:
			"Requests, 4xx and 5xx responses, bytes in and out and average response time over the range",
	}),
};

const uptimeBeat = z.object({
	checkedAt: timestamp,
	detail: z.string().nullable(),
	id: z.string(),
	kind: z.enum(["internal", "external"]),
	latencyMs: z.number().int().nullable(),
	ok: z.boolean(),
	target: z.string().nullable(),
});

export const instanceMonitoringResponse = z.object({
	...monitoringTotals,
	services: z.array(
		z.object({
			avgCpuPercent: z.number().nullable(),
			avgMemUsedMb: z.number().nullable(),
			avgResponseMs: z.number().nullable(),
			bytesIn: z.number(),
			bytesOut: z.number(),
			name: z.string(),
			requests: z.number().int(),
			serviceId: z.string(),
			status4xx: z.number().int(),
			status5xx: z.number().int(),
		}),
	),
});

export const serviceMonitoringResponse = z.object({
	...monitoringTotals,
	uptime: z
		.object({ external: z.array(uptimeBeat), internal: z.array(uptimeBeat) })
		.meta({
			description:
				"The latest 30 beats of each uptime probe, oldest first: internal from the Docker network, external through the public hostname",
		}),
	uptimeEnabled: z.boolean(),
});

export const appLogResponse = z.object({
	createdAt: timestamp,
	id: z.string(),
	level: z.enum(["warn", "error"]),
	message: z.string(),
	metadata: z.string().nullable(),
	scope: z.string().nullable(),
	serviceId: z.string().nullable(),
	serviceName: z.string().nullable(),
});

export const infraContainerResponse = z.object({
	id: z.string(),
	image: z.string(),
	name: z.string(),
	project: z.string(),
	service: z.string(),
	state: z.string(),
});

const cleanupCategory = z.object({
	items: z.array(
		z.object({
			dangling: z.boolean().optional(),
			detail: z.string().optional(),
			id: z.string(),
			label: z.string(),
			sizeBytes: z.number().optional(),
		}),
	),
	totalCount: z.number().int(),
	totalSizeBytes: z.number().optional(),
});

export const dockerCleanupPreviewResponse = z.object({
	buildCache: cleanupCategory,
	containers: cleanupCategory,
	images: cleanupCategory,
	networks: cleanupCategory,
	orphanStackNetworks: z.array(
		z.object({
			containersAttached: z.number().int(),
			id: z.string(),
			name: z.string(),
			stackId: z.string(),
		}),
	),
	volumes: cleanupCategory,
});

const unauthorized: ResponseDef = {
	description: "Unauthorized",
	schema: errorResponse,
};
const notFound: ResponseDef = {
	description: "Not found",
	schema: errorResponse,
};
const unsupported: ResponseDef = {
	description:
		"Built from git, or an environment, preview or canary of another service: no version pinning",
	schema: errorResponse,
};
const serviceParam: ParamDef[] = [
	{ description: "Service id", name: "serviceId" },
];
const rangeParams: ParamDef[] = [
	{
		description: "today, week (the default), month, year or all",
		name: "range",
	},
	{
		description: "IANA time zone deciding where today starts (default UTC)",
		name: "zone",
	},
];
const versionState = (description: string): ResponseDef => ({
	description,
	schema: serviceVersionResponse,
});

/** The REST routes of a service's version pinning and update checks. */
const versionRoutes: RouteDef[] = [
	{
		description:
			"An image service's pin (the tag it runs and the floating tag it was pinned from) and its last update check, with the trial run of the update it found.",
		method: "get",
		path: "/services/{serviceId}/version",
		pathParams: serviceParam,
		responses: {
			200: versionState("The version state"),
			400: unsupported,
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a service's version pin and update check",
		tags: ["Services"],
	},
	{
		description:
			"Turns the update watch, and trying each update first, on or off. Turning the watch off forgets the last check; turning it on runs the first check in the background.",
		method: "patch",
		path: "/services/{serviceId}/version",
		pathParams: serviceParam,
		requestBody: serviceVersionWatchApiBody,
		responses: {
			200: versionState("The version state"),
			400: unsupported,
			401: unauthorized,
			404: notFound,
		},
		summary: "Turn a service's update watch on or off",
		tags: ["Services"],
	},
	{
		description:
			"The registry tags published for exactly the image the service runs, to pin to one of them, and a tag to make on this host when none matches.",
		method: "get",
		path: "/services/{serviceId}/version/pin",
		pathParams: serviceParam,
		responses: {
			200: { description: "The candidates", schema: pinCandidatesResponse },
			400: unsupported,
			401: unauthorized,
			404: notFound,
		},
		summary: "Find the tags a service can be pinned to",
		tags: ["Services"],
	},
	{
		description:
			"Pins the service to a tag. A registry tag replaces the floating one, the image is the same so nothing redeploys. A local tag is made on this host from the running image first, and the pull policy moves to missing.",
		method: "post",
		path: "/services/{serviceId}/version/pin",
		pathParams: serviceParam,
		requestBody: servicePinApiBody,
		responses: {
			200: versionState("Pinned"),
			400: {
				description:
					"An invalid tag, a service that can't be pinned, or a running image no longer on this host",
				schema: errorResponse,
			},
			401: unauthorized,
			404: notFound,
		},
		summary: "Pin a service to a tag",
		tags: ["Services"],
	},
	{
		description:
			"Puts the service back on the tag it was pinned from. Takes effect on its next deploy; a service that isn't pinned is left as is.",
		method: "delete",
		path: "/services/{serviceId}/version/pin",
		pathParams: serviceParam,
		responses: {
			200: versionState("Unpinned"),
			400: unsupported,
			401: unauthorized,
			404: notFound,
		},
		summary: "Unpin a service",
		tags: ["Services"],
	},
	{
		description:
			"Asks the registry for an update now and records it. A new update's trial run and notification carry on in the background: read GET /version again for the trial's outcome.",
		method: "post",
		path: "/services/{serviceId}/version/check",
		pathParams: serviceParam,
		responses: {
			200: versionState("The check's outcome"),
			400: unsupported,
			401: unauthorized,
			404: notFound,
			502: {
				description: "The registry couldn't be read",
				schema: errorResponse,
			},
		},
		summary: "Check a service for updates",
		tags: ["Services"],
	},
	{
		description:
			"Moves the service onto the update its last check found and queues the deploy. A pinned service stays pinned, to the new tag.",
		method: "post",
		path: "/services/{serviceId}/version/update",
		pathParams: serviceParam,
		responses: {
			202: versionState("The service's new tag, its deploy queued"),
			400: unsupported,
			401: unauthorized,
			404: notFound,
			409: {
				description: "There's no update to apply",
				schema: errorResponse,
			},
		},
		summary: "Apply a service's available update",
		tags: ["Services"],
	},
];

/** The REST routes of monitoring, the system log, the instance's own containers and Docker cleanup. */
const systemRoutes: RouteDef[] = [
	{
		description:
			"The instance's traffic, availability and host CPU and memory over a range, with each service's share, busiest first.",
		method: "get",
		path: "/monitoring",
		queryParams: rangeParams,
		responses: {
			200: { description: "The totals", schema: instanceMonitoringResponse },
			400: { description: "An unknown range or zone", schema: errorResponse },
			401: unauthorized,
		},
		summary: "Get the instance's monitoring",
		tags: ["Monitoring"],
	},
	{
		description:
			"A service's traffic, availability and resources over a range, and the latest beats of its uptime probes.",
		method: "get",
		path: "/services/{serviceId}/monitoring",
		pathParams: serviceParam,
		queryParams: rangeParams,
		responses: {
			200: { description: "The totals", schema: serviceMonitoringResponse },
			400: { description: "An unknown range or zone", schema: errorResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Get a service's monitoring and uptime",
		tags: ["Monitoring"],
	},
	{
		description:
			"Homerun's own warnings and errors, newest first, with the service each one is about.",
		method: "get",
		path: "/system/logs",
		queryParams: [
			{
				description: "How many entries, 1 to 500 (default 100)",
				name: "limit",
			},
		],
		responses: {
			200: {
				description: "The entries",
				isArray: true,
				schema: appLogResponse,
			},
			400: { description: "An invalid limit", schema: errorResponse },
			401: unauthorized,
		},
		summary: "Read the system log",
		tags: ["System"],
	},
	{
		description:
			"The containers of the instance's own compose project: the app, the worker, Traefik, Postgres and the rest.",
		method: "get",
		path: "/system/containers",
		responses: {
			200: {
				description: "The containers",
				isArray: true,
				schema: infraContainerResponse,
			},
			401: unauthorized,
		},
		summary: "List the instance's containers",
		tags: ["System"],
	},
	{
		description:
			"The latest lines one of the instance's own containers logged. Only those containers can be read here.",
		method: "get",
		path: "/system/containers/{containerId}/logs",
		pathParams: [{ description: "Container id", name: "containerId" }],
		queryParams: [
			{
				description: "How many of the latest lines, 1 to 10000 (default 200)",
				name: "tail",
			},
		],
		responses: {
			200: { contentType: "text/plain", description: "The log lines" },
			400: { description: "An invalid tail", schema: errorResponse },
			401: unauthorized,
			404: notFound,
		},
		summary: "Read one of the instance's containers' logs",
		tags: ["System"],
	},
	{
		description:
			"What each prune would remove on this host, with sizes: stopped containers, unused images (never one a retained revision needs), unused networks, build cache, unused volumes (never one a service mounts) and the networks of deleted stacks.",
		method: "get",
		path: "/system/docker-cleanup",
		responses: {
			200: {
				description: "The preview",
				schema: dockerCleanupPreviewResponse,
			},
			401: unauthorized,
		},
		summary: "Preview a Docker cleanup",
		tags: ["System"],
	},
	{
		description:
			"Queues a prune as an exclusive job: it waits for running jobs and holds new ones back while it runs. Follow it with GET /jobs/{jobId}.",
		method: "post",
		path: "/system/docker-cleanup",
		requestBody: dockerCleanupApiBody,
		responses: {
			202: {
				description: "Queued",
				schema: z.object({ action: z.string(), jobId: z.string() }),
			},
			400: { description: "An unknown action", schema: errorResponse },
			401: unauthorized,
		},
		summary: "Run a Docker cleanup",
		tags: ["System"],
	},
];

export const operationsRoutes: RouteDef[] = [...versionRoutes, ...systemRoutes];
