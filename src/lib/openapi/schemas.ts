import { z } from "zod";
import { BUILD_METHODS } from "#lib/build-methods.js";
import { HISTORY_TRIGGERS } from "#lib/deploy-trigger.js";
import { AUTH_PATHS_MODES } from "#lib/path-patterns.js";
import { UPDATE_CHANNELS } from "#lib/update-channel.js";

/**
 * Response-shape schemas for the OpenAPI spec. Request bodies are generated
 * straight from `#lib/server/validation/api.ts`'s real validation schemas
 * (single source of truth, zero drift risk); these response schemas are
 * hand-mirrored from `src/lib/server/db/schema.ts`'s columns instead,
 * because every route's response is a DTO's `.toJSON()` : the raw DB row,
 * not something already validated by a zod schema at runtime. Keep these in
 * sync by hand if the schema changes; there's no single source of truth for
 * the response side the way there is for requests.
 */

const isoTimestamp = z.string().meta({
	description: "ISO 8601 timestamp",
	example: "2026-08-20T12:00:00.000Z",
});

export const errorResponse = z.object({
	error: z.string(),
	issues: z.unknown().optional(),
});

const publishedPortsField = z
	.array(
		z.object({
			containerPort: z.number().int(),
			hostPort: z.number().int(),
			protocol: z.enum(["tcp", "udp"]),
		}),
	)
	.meta({
		description:
			"Host ports bound straight to the container, for UDP and non-HTTP TCP",
	});

export const serviceResponse = z.object({
	authAllowedEmails: z.array(z.string()),
	authAllowedGroups: z.array(z.string()),
	authAllowedUserIds: z.array(z.string()),
	authPaths: z.array(z.string()).meta({
		description: "Path patterns authPathsMode applies to",
	}),
	authPathsMode: z.enum(AUTH_PATHS_MODES).meta({
		description:
			"Which paths the login wall covers: all, only authPaths, or all except them",
	}),
	authProviders: z.array(z.string()),
	authRequired: z.boolean(),
	blockedPaths: z.array(z.string()).meta({
		description: "Path patterns Traefik answers with a 403",
	}),
	autoRollback: z.boolean().meta({
		description:
			"Redeploy the previous healthy revision when a new one is unhealthy",
	}),
	buildCacheBuiltin: z.boolean(),
	buildCacheRegistryId: z.string().nullable(),
	buildServerRemoteHostId: z.string().nullable(),
	buildSource: z.enum(["image", "git"]),
	channelBranch: z.string().nullable(),
	channelCanary: z.boolean(),
	channelCanaryDomain: z.string().nullable(),
	channelTagPattern: z.string(),
	channelsEnabled: z.boolean(),
	containerId: z.string().nullable(),
	containerPort: z.number().int(),
	cpuLimit: z.string().nullable(),
	createdAt: isoTimestamp,
	cronEnabled: z.boolean(),
	cronLastRunAt: isoTimestamp.nullable(),
	cronSchedule: z.string().nullable(),
	currentStatus: z.enum([
		"pending",
		"pulling",
		"starting",
		"running",
		"stopped",
		"failed",
		"missing",
	]),
	capAdd: z.array(z.string()),
	command: z.array(z.string()).nullable(),
	devices: z.array(z.string()),
	entrypoint: z.array(z.string()).nullable(),
	envFiles: z.array(z.string()),
	labels: z.record(z.string(), z.string()),
	privileged: z.boolean(),
	runAsUser: z.string().nullable(),
	customSslSet: z
		.boolean()
		.meta({ description: "Whether a custom certificate and key are set." }),
	defaultDomainEnabled: z.boolean(),
	desiredState: z.enum(["running", "stopped"]),
	dnsResolvable: z.boolean(),
	domains: z.array(z.string()),
	envVars: z.record(z.string(), z.string()),
	environmentName: z.string().nullable().meta({
		description:
			"Custom environment name its deployments are recorded under, null for production. Canaries and previews ignore it.",
	}),
	secretEnvKeys: z.array(z.string()),
	autoDeployOnPush: z.boolean(),
	gitBakeFile: z.string().nullable(),
	primaryDomain: z.string().nullable(),
	gitBuildTarget: z.string().nullable(),
	gitBuildContext: z.string().nullable(),
	gitBuildMethod: z.enum(BUILD_METHODS),
	gitDockerfilePath: z.string().nullable(),
	gitProviderId: z.string().nullable(),
	gitRef: z.string().nullable(),
	gitRepo: z.string().nullable(),
	gitUrl: z.string().nullable(),
	gitWebhookError: z.string().nullable(),
	gitWebhookId: z.string().nullable(),
	gitWebhookReconnect: z.boolean(),
	gitPollEnabled: z.boolean(),
	gitWatchPaths: z.array(z.string()).meta({
		description:
			"Repo path globs a push has to change a file under to deploy, empty for any file",
	}),
	gitIgnorePaths: z.array(z.string()).meta({
		description: "Repo path globs whose changes alone never deploy on push",
	}),
	gitLastSeenCommit: z.string().nullable(),
	previewAuthAllowedEmails: z.array(z.string()),
	previewAuthAllowedGroups: z.array(z.string()),
	previewAuthAllowedUserIds: z.array(z.string()),
	previewAuthProviders: z.array(z.string()),
	previewAuthRequired: z.boolean(),
	previewDefaultDomain: z.boolean(),
	previewReportGithub: z.boolean(),
	previewBranchExclude: z.array(z.string()),
	previewCopyVolumes: z.boolean(),
	previewEnvOverrides: z.record(z.string(), z.string()),
	previewInheritEnv: z.boolean(),
	previewUptimeEnabled: z.boolean(),
	previewBranchInclude: z.array(z.string()),
	previewDomainTemplate: z.string().nullable(),
	previewsEnabled: z.boolean(),
	previewParentId: z.string().nullable(),
	previewPrNumber: z.number().int().nullable(),
	previewPrTitle: z.string().nullable(),
	previewBranch: z.string().nullable(),
	healthcheckCommand: z.string().nullable(),
	healthcheckDisabled: z.boolean(),
	healthcheckIntervalSeconds: z.number().int().nullable(),
	healthcheckRetries: z.number().int().nullable(),
	healthcheckStartPeriodSeconds: z.number().int().nullable(),
	healthcheckTimeoutSeconds: z.number().int().nullable(),
	httpCacheTtl: z.number().int().nullable(),
	id: z.string(),
	image: z.string(),
	imageScanEnabled: z.boolean(),
	memoryLimitMb: z.number().int().nullable(),
	name: z.string(),
	networkMode: z.enum(["bridge", "host"]),
	portProtocol: z.enum(["tcp", "udp", "both"]),
	publishedPorts: publishedPortsField,
	domainPorts: z.record(z.string(), z.number().int()).meta({
		description:
			"Per custom domain, the container port it routes to instead of containerPort",
	}),
	stripPathDomains: z.array(z.string()).meta({
		description:
			"The custom domains with a path whose prefix is stripped before the request reaches the container",
	}),
	category: z.string().nullable().meta({
		description: "The app's type, a template category like database",
	}),
	icon: z.string().nullable().meta({
		description:
			"A bundled template icon file name, a Dashboard Icons name as di:<name>, or an uploaded data:image URL",
	}),
	stackId: z.string().nullable(),
	registryPasswordSet: z
		.boolean()
		.meta({ description: "Whether a registry password is set." }),
	registryUrl: z.string().nullable(),
	registryUsername: z.string().nullable(),
	requireStatusChecks: z.boolean().meta({
		description:
			"Git builds only: every check in requiredStatusChecks must pass on the commit before it's built",
	}),
	requiredStatusChecks: z.array(z.string()),
	pullPolicy: z.enum(["always", "missing", "never"]),
	replicas: z.number().int(),
	restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]),
	slug: z.string(),
	swarmServiceId: z.string().nullable(),
	tag: z.string(),
	pinnedFromTag: z.string().nullable().meta({
		description:
			"The floating tag the service was pinned from, null when it isn't pinned. See /services/{serviceId}/version.",
	}),
	pinnedLocally: z.boolean().meta({
		description:
			"Whether the pinned tag was made on this host from the running image rather than found in the registry",
	}),
	tracesEnabled: z.boolean(),
	updateCheck: z
		.object({
			available: z
				.object({
					digest: z.string().nullable(),
					foundAt: isoTimestamp,
					tag: z.string(),
				})
				.nullable(),
			checkedAt: isoTimestamp,
			error: z.string().nullable(),
			notifiedKey: z.string().nullable(),
			trial: z
				.object({
					at: isoTimestamp,
					message: z.string().nullable(),
					status: z.enum(["running", "passed", "failed"]),
					tag: z.string(),
				})
				.nullable(),
		})
		.nullable()
		.meta({ description: "The last update check, null before the first" }),
	updateCheckEnabled: z.boolean(),
	updateTrialEnabled: z.boolean(),
	updatedAt: isoTimestamp,
	uptimeEnabled: z.boolean().meta({
		description:
			"Whether the per-minute internal and external uptime probes run for this service",
	}),
	userId: z.string(),
});

export const stackResponse = z.object({
	createdAt: isoTimestamp,
	description: z.string().nullable(),
	icon: z.string().nullable(),
	id: z.string(),
	name: z.string(),
	parentId: z.string().nullable().meta({
		description: "The stack this one is nested in, null at the top level.",
	}),
	slug: z.string(),
	updatedAt: isoTimestamp,
	userId: z.string(),
});

export const templateResponse = z.object({
	capAdd: z.array(z.string()),
	category: z.string().nullable(),
	command: z.array(z.string()).nullable(),
	containerPort: z.number().int(),
	cpuLimit: z.string().nullable(),
	createdAt: isoTimestamp,
	description: z.string().nullable(),
	devices: z.array(z.string()),
	entrypoint: z.array(z.string()).nullable(),
	envFiles: z.array(z.string()),
	envVars: z.record(z.string(), z.string()).nullable(),
	icon: z.string().nullable(),
	id: z.string(),
	image: z.string(),
	labels: z.record(z.string(), z.string()),
	memoryLimitMb: z.number().int().nullable(),
	name: z.string(),
	ownerId: z
		.string()
		.nullable()
		.meta({ description: "null = built-in template" }),
	privileged: z.boolean().meta({
		description:
			"privileged, devices, capAdd and envFiles need host access : only an admin can deploy a template that sets any of them",
	}),
	publishedPorts: publishedPortsField,
	restartPolicy: z.string(),
	runAsUser: z.string().nullable(),
	tag: z.string(),
	updatedAt: isoTimestamp,
});

export const deployResultResponse = z.object({
	containerId: z.string().optional(),
	deploymentId: z.string(),
	error: z.string().optional(),
	success: z.boolean(),
});

export const revisionResponse = z.object({
	buildSource: z.enum(["image", "git"]).nullable(),
	createdAt: isoTimestamp.meta({
		description: "When this revision was first deployed",
	}),
	current: z.boolean().meta({ description: "The revision running now" }),
	environment: z.string().meta({
		description:
			"The environment it deployed: production, canary (a release channel's canary service) or preview (a pull request preview)",
	}),
	gitCommit: z.string().nullable(),
	gitRef: z.string().nullable(),
	health: z
		.enum(["watching", "healthy", "unhealthy", "rolled_back"])
		.nullable()
		.meta({
			description:
				"Health of its latest run. watching and healthy only ever appear on the current revision; unhealthy and rolled_back are kept as history; null otherwise",
		}),
	healthReason: z.string().nullable().meta({
		description:
			"Why the health watch judged it unhealthy or rolled it back (a failing healthcheck, a restart loop, failed swarm tasks and their error), null otherwise",
	}),
	id: z.string().meta({
		description:
			"The revision's original deployment id, what POST /services/{serviceId}/revisions/{revisionId}/deploy takes",
	}),
	imageDigest: z.string().nullable(),
	imageId: z.string().nullable(),
	imageRef: z.string().nullable(),
	lastDeployedAt: isoTimestamp.nullable().meta({
		description:
			"When this revision last went live, later than createdAt once it was redeployed",
	}),
	latestDeploymentId: z.string().meta({
		description:
			"The deployment row of its latest run, id itself unless it was redeployed",
	}),
	previous: z.boolean().meta({
		description:
			"The default rollback target: the newest older healthy revision with a different image",
	}),
	redeployCount: z.number().int().meta({
		description: "How many times it was redeployed (rolled back to)",
	}),
	retained: z.boolean().meta({
		description:
			"Its image is among the last distinct images kept on the host and in the mirror",
	}),
	status: z.enum([
		"pending",
		"pulling",
		"starting",
		"running",
		"stopped",
		"failed",
		"missing",
	]),
});

export const deploymentResponse = z.object({
	createdAt: isoTimestamp,
	environment: z.string().meta({
		description:
			"The environment it deployed: production, canary (a release channel's canary service) or preview (a pull request preview)",
	}),
	errorMessage: z.string().nullable().meta({
		description: "Why the deploy failed, null unless status is failed",
	}),
	finishedAt: isoTimestamp.nullable(),
	gitCommit: z.string().nullable(),
	gitRef: z.string().nullable(),
	id: z.string(),
	imageDigest: z.string().nullable(),
	imageRef: z.string().nullable(),
	log: z.string().nullable().meta({
		description:
			"The deploy's progress lines as the dashboard shows them: pull, scan, rollout, and the Docker error when it failed",
	}),
	rollbackOfDeploymentId: z.string().nullable().meta({
		description:
			"The deployment whose image this one redeployed: the revision a rollback went back to, or the preview revision a promote deployed",
	}),
	startedAt: isoTimestamp.nullable(),
	status: z.enum([
		"pending",
		"pulling",
		"starting",
		"running",
		"stopped",
		"failed",
		"missing",
	]),
	trigger: z.enum(HISTORY_TRIGGERS).nullable().meta({
		description:
			"What started it: manual, cron (scheduled), push (git push), promote (a pull request preview promoted) or rollback; null for a deploy from before triggers were recorded",
	}),
});

export const successResponse = z.object({ success: z.boolean() });

const JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;

export const jobSummaryResponse = z.object({
	attempts: z
		.number()
		.meta({ description: "How many times it has been claimed" }),
	createdAt: isoTimestamp,
	heartbeatAt: isoTimestamp.nullable().meta({
		description:
			"The Go worker's last heartbeat while it executes the job, null when no worker holds it",
	}),
	id: z.string(),
	serviceId: z.string().nullable(),
	serviceName: z.string().nullable(),
	stage: z
		.enum(["prepare", "execute", "finalize", "finalizing"])
		.nullable()
		.meta({
			description:
				"prepare and finalize(ing) run in the app, execute in the Go worker, null for a job the app runs itself",
		}),
	stale: z.boolean().meta({
		description:
			"Running in execute with no heartbeat (or, never leased, no claim) for over two minutes: no live worker is on it",
	}),
	startedAt: isoTimestamp.nullable(),
	status: z.enum(JOB_STATUSES),
	title: z.string(),
	type: z.string(),
	workerId: z.string().nullable().meta({
		description: "The Go worker holding the job's lease",
	}),
});

export const instanceUpdateStatusResponse = z.object({
	channel: z.enum(UPDATE_CHANNELS).meta({
		description:
			"The release channel updates follow, set on Settings → General",
	}),
	checkedAt: isoTimestamp.nullable().meta({
		description: "When the channel's newest release was last looked up",
	}),
	current: z.string().meta({ description: "The running version" }),
	latest: z
		.object({
			publishedAt: isoTimestamp.nullable(),
			url: z.string(),
			version: z.string(),
		})
		.nullable()
		.meta({
			description:
				"The newest release on the channel, null when it couldn't be checked",
		}),
	preflight: z.object({
		blockers: z.array(jobSummaryResponse).meta({
			description:
				"The jobs keeping an update from starting: queued or running deploys and every running job, running first",
		}),
		pendingDeploys: z.number(),
		reason: z.string().nullable().meta({
			description: "Why an update can't start right now, null when ready",
		}),
		ready: z.boolean(),
		runningJobs: z.number(),
		supported: z.boolean().meta({
			description:
				"Whether this instance runs as a Docker Compose service it can recreate",
		}),
	}),
	updateAvailable: z.boolean(),
});

export const instanceUpdateChannelResponse = z.object({
	channel: z.enum(UPDATE_CHANNELS),
});

export const instanceUpdateStartResponse = z.object({
	version: z.string().meta({ description: "The version being installed" }),
});

export const instanceUpdateProgressResponse = z.object({
	exitCode: z.number().nullable().meta({
		description: "The updater's exit code once it has exited, 0 on success",
	}),
	log: z.array(z.string()).meta({ description: "The updater's output lines" }),
	state: z.enum(["exited", "none", "running"]).meta({
		description: "none when no update has run on this host",
	}),
	version: z
		.string()
		.nullable()
		.meta({ description: "The version the updater is installing" }),
});

export const systemStatsResponse = z.object({
	cpuPercent: z.number(),
	diskTotalGb: z.number().nullable(),
	diskUsedGb: z.number().nullable(),
	gpu: z
		.object({
			memTotalMb: z.number(),
			memUsedMb: z.number(),
			name: z.string(),
			utilizationPercent: z.number(),
		})
		.nullable(),
	memTotalMb: z.number(),
	memUsedMb: z.number(),
});

const severityCounts = z.object({
	critical: z.number().int(),
	high: z.number().int(),
	low: z.number().int(),
	medium: z.number().int(),
	unknown: z.number().int(),
});

export const imageScanSummaryResponse = z.object({
	counts: severityCounts,
	deploymentId: z
		.string()
		.nullable()
		.meta({ description: "null = scanned on demand, not during a deploy" }),
	digest: z.string().nullable(),
	error: z
		.string()
		.nullable()
		.meta({ description: "Why a failed or skipped scan has no findings" }),
	fixableCounts: severityCounts.nullable().meta({
		description:
			"Findings that have a fixed version, per severity. null on scans recorded before this was tracked",
	}),
	id: z.string(),
	imageRef: z.string(),
	scannedAt: isoTimestamp,
	serviceId: z.string(),
	source: z.string(),
	status: z.enum(["ok", "failed", "skipped"]),
	totalFindings: z.number().int().meta({
		description:
			"Every unique finding, including those beyond the stored findings cap",
	}),
});

export const imageScanResponse = imageScanSummaryResponse.extend({
	findings: z
		.array(
			z.object({
				fixedVersion: z.string().nullable(),
				id: z.string(),
				installedVersion: z.string(),
				pkg: z.string(),
				severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
				title: z.string().nullable(),
			}),
		)
		.meta({
			description:
				"Sorted most severe first, capped at 200 : totalFindings has the real count",
		}),
});

export const queuedJobResponse = z.object({
	jobId: z.string(),
	status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
});

export const pushWebhookResponse = z.object({
	error: z.string().nullable().meta({
		description:
			"Why Homerun couldn't register the webhook itself, if it couldn't",
	}),
	polling: z.boolean().meta({
		description:
			"Whether Homerun polls the branch head every two minutes instead of, or as well as, waiting for deliveries",
	}),
	providerName: z.string().nullable(),
	reconnect: z
		.object({ providerId: z.string(), providerName: z.string() })
		.nullable()
		.meta({
			description:
				"The provider to reconnect when it refused the webhook, usually for a missing webhook scope",
		}),
	registered: z.boolean().meta({
		description: "Whether Homerun registered the webhook on the provider",
	}),
	secret: z
		.string()
		.meta({ description: "The secret deliveries are signed with" }),
	url: z.string().nullable().meta({
		description: "Where the provider should send push events",
	}),
});

export const scanConflictResponse = z.object({
	error: z.string(),
	jobId: z.string().meta({ description: "The scan job already in flight" }),
});

export const domainConflictResponse = z.object({
	canTakeOver: z.boolean().optional().meta({
		description:
			"Whether sending the same change again with takeOverDomains: true would move every conflicting domain to this service",
	}),
	conflicts: z
		.array(
			z.object({
				canTakeOver: z.boolean().meta({
					description:
						"Whether this owner can give the domain up: only a service or a redirect can",
				}),
				domain: z.string().meta({
					description: "The domain entry asked for, with its path if any",
				}),
				owner: z.string().meta({
					description:
						'Who routes it now, as the dashboard names it: the service "Web", a workstation, the Homerun dashboard',
				}),
				ownerId: z.string().nullable().meta({
					description: "The service or redirect id, null for the others",
				}),
				ownerKind: z.enum(["core", "redirect", "service", "workstation"]).meta({
					description:
						"core is Homerun itself: the dashboard, the registry or object storage's public host, a status page",
				}),
			}),
		)
		.optional()
		.meta({
			description:
				"Set when a domain this change adds (or the default hostname a slug or stack change moves) is already routed elsewhere",
		}),
	error: z.string(),
});

export const jobResponse = z.object({
	attempts: z
		.number()
		.meta({ description: "How many times it has been claimed" }),
	createdAt: isoTimestamp,
	error: z.string().nullable(),
	finishedAt: isoTimestamp.nullable(),
	heartbeatAt: isoTimestamp.nullable().meta({
		description:
			"The Go worker's last heartbeat while it executes the job, null when no worker holds it",
	}),
	id: z.string(),
	log: z.string().meta({
		description: "Its progress log, every attempt appended to the same text",
	}),
	maxAttempts: z.number(),
	progressAt: isoTimestamp.nullable().meta({
		description:
			"The last time it moved a byte or got a Docker answer; the worker fails a job whose progressAt is older than its stall timeout",
	}),
	result: z.record(z.string(), z.unknown()).nullable(),
	serviceId: z.string().nullable(),
	stage: z.enum(["prepare", "execute", "finalize", "finalizing"]).nullable(),
	startedAt: isoTimestamp.nullable(),
	status: z.enum(JOB_STATUSES),
	title: z.string(),
	type: z.string(),
});
