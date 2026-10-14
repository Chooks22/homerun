import { z } from "zod";
import { BAKE_TARGET_PATTERN, BUILD_METHODS } from "#lib/build-methods.js";
import { AUTH_PATHS_MODES, pathPatternsProblem } from "#lib/path-patterns.js";
import { PERMISSION_AREAS, PERMISSION_LEVELS } from "#lib/permissions.js";
import { branchPatternProblem } from "#lib/preview-branches.js";
import { environmentNameField } from "#lib/server/validation/environment-name.js";
import { isDomainEntry, normalizeDomain } from "#lib/service-domains.js";
import { isRunAsUser } from "#lib/service-runtime.js";
import { UPDATE_CHANNELS } from "#lib/update-channel.js";

const branchPatterns = z
	.array(z.string().trim().min(1))
	.max(50)
	.superRefine((patterns, ctx) => {
		const problem = patterns.map(branchPatternProblem).find(Boolean);
		if (problem) {
			ctx.addIssue({ code: "custom", message: problem });
		}
	});

const pathPatterns = z
	.array(z.string().trim().min(1))
	.superRefine((patterns, ctx) => {
		const problem = pathPatternsProblem(patterns);
		if (problem) {
			ctx.addIssue({ code: "custom", message: problem });
		}
	});

/** Repo path globs for a git service's watch or ignore paths: trimmed, without a leading slash, at most 50 of up to 200 characters. */
export const watchPathPatterns = z
	.array(
		z
			.string()
			.trim()
			.overwrite((pattern) => pattern.replace(/^\/+/, ""))
			.min(1, "A watch path can't be empty.")
			.max(200, "A watch path is at most 200 characters."),
	)
	.max(50, "At most 50 watch paths.");

/**
 * Request-body schemas for the JSON REST API (`src/routes/api/v1/**`) : kept
 * separate from `validation/service.ts`'s FormData-shaped schemas (checkbox/
 * `envKey[]`/`envValue[]` preprocessing that only makes sense for an HTML
 * form submission). These are also the single source of truth the OpenAPI
 * spec (`#lib/openapi/`) is generated from via `z.toJSONSchema()` : the same
 * schema instance validates a request *and* documents it, so the two can't
 * drift the way a hand-maintained spec would.
 */

const SLUG_RE = /^[a-z0-9-]{1,63}$/;

const argvField = z
	.array(z.string())
	.max(200)
	.nullable()
	.meta({ description: "Argv list, null keeps the image's own" });

const runtimeFields = {
	capAdd: z.array(z.string().regex(/^(CAP_)?[A-Za-z_]+$/)).max(50),
	command: argvField,
	devices: z
		.array(z.string().min(1))
		.max(50)
		.meta({ description: "host[:container[:rwm]] device mappings" }),
	entrypoint: argvField,
	envFiles: z
		.array(z.string().regex(/^\//))
		.max(20)
		.meta({ description: "Absolute host paths of .env files read at deploy" }),
	labels: z.record(z.string(), z.string()),
	privileged: z.boolean(),
	runAsUser: z
		.string()
		.refine(isRunAsUser, "Use uid, uid:gid, name or name:group.")
		.nullable()
		.meta({
			description:
				"Docker User (uid, uid:gid, name or name:group), null keeps the image's",
		}),
};

const healthSeconds = z.number().int().min(1).max(3600).nullable();
const portNumber = z.number().int().min(1).max(65_535);
const stringList = z.array(z.string().trim().min(1)).max(200);

const serviceSettingsFields = {
	authAllowedEmails: stringList.optional(),
	authAllowedGroups: stringList.optional(),
	authAllowedUserIds: stringList.optional(),
	authProviders: stringList
		.optional()
		.describe(
			'Sign-in methods the login wall offers: "password", "email-otp", "magic-link" or "oauth:<provider name>", each enabled on the instance. An emailed method lets any account through unless authAllowedEmails or authAllowedUserIds narrow it.',
		),
	buildCacheBuiltin: z
		.boolean()
		.optional()
		.describe("Use the built-in registry as a git build's layer cache."),
	buildCacheRegistryId: z.string().nullable().optional(),
	buildServerRemoteHostId: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
	channelBranch: z.string().trim().nullable().optional(),
	channelCanaryDomain: z.string().trim().toLowerCase().nullable().optional(),
	channelTagPattern: z.string().trim().min(1).optional(),
	channelsEnabled: z
		.boolean()
		.optional()
		.describe(
			"Release channels: a canary service deployed from channelBranch, the service itself from tags matching channelTagPattern.",
		),
	cronEnabled: z.boolean().optional(),
	cronSchedule: z
		.string()
		.trim()
		.nullable()
		.optional()
		.describe("5-field cron expression the service is redeployed on."),
	customSslCert: z
		.string()
		.trim()
		.nullable()
		.optional()
		.describe(
			"PEM certificate, sent with customSslKey. null on both removes them. Never returned.",
		),
	customSslKey: z.string().trim().nullable().optional(),
	domainPorts: z
		.record(z.string().overwrite(normalizeDomain), portNumber)
		.optional()
		.describe("Container port per domain, when it isn't containerPort."),
	stripPathDomains: z
		.array(z.string().overwrite(normalizeDomain))
		.optional()
		.describe(
			"The domains with a path whose prefix is stripped before the request reaches the container.",
		),
	healthcheckDisabled: z.boolean().optional(),
	healthcheckIntervalSeconds: healthSeconds.optional(),
	healthcheckRetries: z.number().int().min(1).max(100).nullable().optional(),
	healthcheckStartPeriodSeconds: z
		.number()
		.int()
		.min(0)
		.max(3600)
		.nullable()
		.optional(),
	healthcheckTimeoutSeconds: healthSeconds.optional(),
	httpCacheTtl: z.number().int().min(1).max(86_400).nullable().optional(),
	icon: z.string().nullable().optional(),
	networkMode: z.enum(["bridge", "host"]).optional(),
	portProtocol: z.enum(["tcp", "udp", "both"]).optional(),
	previewAuthAllowedEmails: stringList.optional(),
	previewAuthAllowedGroups: stringList.optional(),
	previewAuthAllowedUserIds: stringList.optional(),
	previewAuthProviders: stringList.optional(),
	previewAuthRequired: z.boolean().optional(),
	previewDefaultDomain: z.boolean().optional(),
	previewDomainTemplate: z.string().trim().toLowerCase().nullable().optional(),
	publishedPorts: z
		.array(
			z.object({
				containerPort: portNumber,
				hostPort: portNumber,
				protocol: z.enum(["tcp", "udp"]).default("tcp"),
			}),
		)
		.optional(),
	replicas: z.number().int().min(0).max(50).optional(),
	secretEnvKeys: z
		.array(z.string())
		.optional()
		.describe("envVars keys the dashboard masks."),
	slug: z.string().regex(SLUG_RE).optional(),
	stackId: z.string().nullable().optional(),
	tracesEnabled: z.boolean().optional(),
};

export const updateServiceApiBody = z.object({
	authPaths: pathPatterns
		.optional()
		.describe(
			"Path patterns authPathsMode applies to. A pattern matches whole path segments anywhere in the path, a leading / anchors it at the root, * matches anything and ? one character, case-insensitively.",
		),
	authPathsMode: z
		.enum(AUTH_PATHS_MODES)
		.optional()
		.describe(
			"Which paths the login wall covers: all, only the authPaths, or all except them. Applied on the next deploy, which saving queues for a running service.",
		),
	authRequired: z.boolean().optional(),
	blockedPaths: pathPatterns
		.optional()
		.describe(
			"Path patterns Traefik answers with a 403 instead of passing to the app, same syntax as authPaths. Applied on the next deploy, which saving queues for a running service.",
		),
	autoDeployOnPush: z.boolean().optional(),
	autoRollback: z.boolean().optional(),
	buildSource: z.enum(["image", "git"]).optional(),
	capAdd: runtimeFields.capAdd.optional(),
	command: runtimeFields.command.optional(),
	containerPort: z.number().int().min(1).max(65_535).optional(),
	cpuLimit: z.string().nullable().optional(),
	defaultDomainEnabled: z.boolean().optional(),
	domains: z
		.array(
			z
				.string()
				.overwrite(normalizeDomain)
				.refine(isDomainEntry, "Expected a domain, optionally with a path"),
		)
		.optional()
		.describe(
			"Custom domains. One may carry a path (example.com/api) to route only that path prefix.",
		),
	primaryDomain: z.string().trim().toLowerCase().nullable().optional(),
	devices: runtimeFields.devices.optional(),
	dnsResolvable: z.boolean().optional(),
	entrypoint: runtimeFields.entrypoint.optional(),
	envFiles: runtimeFields.envFiles.optional(),
	envVars: z.record(z.string(), z.string()).optional(),
	environmentName: environmentNameField
		.optional()
		.describe(
			"The environment this service's deployments are recorded under, e.g. staging. null or production resets it to production. Canaries and previews keep canary and preview.",
		),
	gitBakeFile: z.string().nullable().optional(),
	gitBuildTarget: z.string().regex(BAKE_TARGET_PATTERN).nullable().optional(),
	gitBuildContext: z.string().nullable().optional(),
	gitBuildMethod: z.enum(BUILD_METHODS).optional(),
	gitDockerfilePath: z.string().nullable().optional(),
	gitProviderId: z.string().nullable().optional(),
	gitRef: z.string().nullable().optional(),
	gitRepo: z.string().nullable().optional(),
	gitUrl: z.string().nullable().optional(),
	gitPollEnabled: z.boolean().optional(),
	gitWatchPaths: watchPathPatterns
		.optional()
		.describe(
			"Repo path globs (apps/api/**, *.md) a push has to change a file under to deploy the service or one of its environments. Empty lets every file through. A pattern without a slash matches at any depth, a folder path everything under it. Only applies when the push payload lists its files (not on Bitbucket, not when polling).",
		),
	gitIgnorePaths: watchPathPatterns
		.optional()
		.describe(
			"Repo path globs whose changes never deploy on push, same syntax as gitWatchPaths: a push deploys when a changed file matches the watch paths and none of these.",
		),
	healthcheckCommand: z.string().max(1000).nullable().optional(),
	image: z.string().min(1).optional(),
	imageScanEnabled: z.boolean().optional(),
	previewsEnabled: z.boolean().optional(),
	previewBranchInclude: branchPatterns
		.optional()
		.describe(
			"Glob patterns (* any run, ? one character) a pull request's head branch must match one of to get a preview. Empty lets every branch through.",
		),
	previewInheritEnv: z
		.boolean()
		.optional()
		.describe(
			"Whether pull request previews start from this service's environment variables.",
		),
	previewEnvOverrides: z
		.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
		.optional()
		.describe(
			"Environment variables set on every preview over what it inherited; {pr}, {branch} and {slug} are filled in.",
		),
	previewCopyVolumes: z
		.boolean()
		.optional()
		.describe(
			"Whether each new preview gets its own copy of this service's volumes.",
		),
	previewReportGithub: z
		.boolean()
		.optional()
		.describe(
			"Whether a GitHub repo's pull requests get a comment with their preview's URL and a deployment in a per-preview environment.",
		),
	previewBranchExclude: branchPatterns
		.optional()
		.describe(
			"Glob patterns whose matching branches never get a preview, even when included.",
		),
	labels: runtimeFields.labels.optional(),
	memoryLimitMb: z.number().int().positive().nullable().optional(),
	name: z.string().min(1).max(100).optional(),
	privileged: runtimeFields.privileged.optional(),
	runAsUser: runtimeFields.runAsUser.optional(),
	pullPolicy: z.enum(["always", "missing", "never"]).optional(),
	registryPassword: z.string().optional(),
	registryUrl: z.string().nullable().optional(),
	registryUsername: z.string().nullable().optional(),
	requireStatusChecks: z.boolean().optional(),
	requiredStatusChecks: z.array(z.string().min(1).max(200)).max(50).optional(),
	restartPolicy: z
		.enum(["no", "always", "on-failure", "unless-stopped"])
		.optional(),
	tag: z.string().min(1).optional(),
	uptimeEnabled: z.boolean().optional(),
	...serviceSettingsFields,
});

/** The validated JSON body of `PATCH /api/v1/services/{serviceId}`, every field optional. */
export type ServiceSettingsInput = z.infer<typeof updateServiceApiBody>;

const baseCreateServiceFields = {
	authRequired: z.boolean().default(false),
	autoDeployOnPush: z.boolean().default(false),
	buildSource: z.enum(["image", "git"]).default("image"),
	containerPort: z.number().int().min(1).max(65_535),
	capAdd: runtimeFields.capAdd.default([]),
	command: runtimeFields.command.optional(),
	cpuLimit: z.string().optional(),
	devices: runtimeFields.devices.default([]),
	dnsResolvable: z.boolean().default(true),
	entrypoint: runtimeFields.entrypoint.optional(),
	envFiles: runtimeFields.envFiles.default([]),
	envVars: z.record(z.string(), z.string()).default({}),
	gitBakeFile: z.string().optional(),
	gitBuildTarget: z.string().regex(BAKE_TARGET_PATTERN).optional(),
	gitBuildContext: z.string().optional(),
	gitBuildMethod: z.enum(BUILD_METHODS).default("dockerfile"),
	gitDockerfilePath: z.string().optional(),
	gitProviderId: z.string().optional(),
	gitRef: z.string().optional(),
	gitRepo: z.string().optional(),
	gitUrl: z.string().optional(),
	image: z.string().optional(),
	labels: runtimeFields.labels.default({}),
	memoryLimitMb: z.number().int().positive().optional(),
	name: z.string().min(1).max(100),
	privileged: runtimeFields.privileged.default(false),
	runAsUser: runtimeFields.runAsUser.optional(),
	stackId: z.string().optional(),
	pullPolicy: z.enum(["always", "missing", "never"]).default("always"),
	registryPassword: z.string().optional(),
	registryUrl: z.string().optional(),
	registryUsername: z.string().optional(),
	restartPolicy: z
		.enum(["no", "always", "on-failure", "unless-stopped"])
		.default("unless-stopped"),
	slug: z.string().regex(SLUG_RE),
	tag: z.string().min(1).optional(),
};

/** `POST /services`: the fields a new service starts from, plus any setting `PATCH` takes, applied right after. */
export const createServiceApiBody = z
	.object({ ...updateServiceApiBody.shape, ...baseCreateServiceFields })
	.refine((v) => v.buildSource !== "git" || !!v.gitUrl, {
		error: 'gitUrl is required when buildSource is "git".',
		path: ["gitUrl"],
	})
	.refine((v) => v.buildSource === "git" || !!v.image, {
		error: 'image is required when buildSource is "image".',
		path: ["image"],
	});

/** The validated JSON body of `POST /api/v1/services`. */
export type CreateServiceApiInput = z.infer<typeof createServiceApiBody>;

/** `POST /services` with a template: the template's service and linked services, then any setting `PATCH` takes. */
export const createServiceFromTemplateApiBody = updateServiceApiBody.extend({
	stackId: z.string().nullable().optional(),
	templateId: z
		.string()
		.min(1)
		.describe(
			"Create the service from this template (image, variables, volumes and linked services), then apply the other fields sent. name and slug default to the template's.",
		),
});

/** `POST /services/{serviceId}/deploy`'s optional body: a tag to switch the service to before deploying, for CI deploying the image it just pushed. */
export const deployServiceApiBody = z.object({
	tag: z
		.string()
		.regex(
			/^[\w][\w.-]{0,127}$/,
			"A Docker tag: letters, digits, _, . and -, up to 128 characters.",
		)
		.optional()
		.describe(
			"Image tag to deploy. Saved on the service first, so later deploys keep it. Image-based services only.",
		),
	environment: z
		.enum(["stable", "production", "canary"])
		.optional()
		.describe(
			"With release channels on: canary deploys the canary service from the canary branch, stable (or production) the service itself at its current ref. Defaults to stable.",
		),
});

export const releaseChannelsApiBody = z.object({
	branch: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"The branch that feeds the canary. Defaults to the one already set, else the service's branch.",
		),
	canaryDomain: z
		.string()
		.trim()
		.toLowerCase()
		.nullable()
		.optional()
		.describe(
			"A custom domain for the canary, null for none (it keeps its default <slug>-canary hostname). Omit to keep the current one.",
		),
	enabled: z
		.boolean()
		.describe(
			"Turn release channels on or off. Off deletes the canary service.",
		),
	tagPattern: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Glob a pushed tag must match to deploy the stable service, e.g. v*. Defaults to the one already set.",
		),
});

export const createStackApiBody = z.object({
	description: z.string().nullable().optional(),
	icon: z.string().nullable().optional(),
	name: z.string().trim().min(1).max(100),
	parentId: z
		.string()
		.nullable()
		.optional()
		.describe("The stack to nest this one in, null for a top-level stack."),
	slug: z.string().regex(SLUG_RE),
});

/** `PATCH /stacks/{stackId}`: the fields sent change, the rest stay. */
export const updateStackApiBody = createStackApiBody.partial();

export const startUpdateApiBody = z.object({
	force: z.boolean().optional().meta({
		description:
			"Update even while deploys are queued or jobs are running. They're interrupted by the restart, then resumed or run again by the new version",
	}),
});

export const updateChannelApiBody = z.object({
	channel: z.enum(UPDATE_CHANNELS).meta({
		description:
			"stable follows stable releases; canary every build merged to main that passed e2e; nightly every build merged to main, published before e2e. Switching to a more stable channel never downgrades",
	}),
});

/** `POST /services/{serviceId}/previews/{prNumber}/promote`'s optional body: the commit CI tested, refused when the preview runs another one. */
export const promotePreviewApiBody = z.object({
	commit: z
		.string()
		.regex(/^[0-9a-f]{7,40}$/i, "A full or abbreviated (7+) commit SHA.")
		.optional()
		.describe(
			"The commit the preview must be running, e.g. the pull request head CI tested. Omitted, whatever the preview runs is promoted.",
		),
});

/** `PUT /services/{serviceId}/previews/{prNumber}`'s body: the image tag CI pushed for the pull request, and what it was built from. */
export const deployPreviewApiBody = z.object({
	branch: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.optional()
		.describe(
			"The pull request's head branch: checked against the service's preview branch filter, a filtered-out branch is refused with 409. Omitted, no filter applies and an existing preview keeps its branch.",
		),
	commit: z
		.string()
		.regex(/^[0-9a-f]{7,40}$/i, "A full or abbreviated (7+) commit SHA.")
		.optional()
		.describe(
			"The commit the image was built from, recorded on the preview's revision so `homerun previews wait --commit` and promote --commit can match it.",
		),
	tag: z
		.string()
		.regex(
			/^[\w][\w.-]{0,127}$/,
			"A Docker tag: letters, digits, _, . and -, up to 128 characters.",
		)
		.describe(
			"The tag of the service's own image the preview runs, pulled with the service's registry credentials.",
		),
	title: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.optional()
		.describe(
			"The pull request's title. Omitted, an existing preview keeps its title.",
		),
});

/** `PUT /services/{serviceId}/dependencies`'s body: the full set of services it depends on, replacing the recorded ones. */
export const serviceDependenciesApiBody = z.object({
	dependsOn: z
		.array(z.string().min(1))
		.max(200)
		.describe(
			"Ids of the services this one depends on, started before it. An empty list clears the recorded ones; env links are left alone.",
		),
});

/** `PATCH /services/{serviceId}/errors/{issueId}`'s body: the issue's new status. */
export const errorIssueStatusApiBody = z.object({
	status: z
		.enum(["unresolved", "resolved", "ignored"])
		.describe(
			"resolved: marked fixed, a new event reopens it as a regression; ignored: kept counting but never notifies; unresolved: open.",
		),
});

export const sourceMapReleaseParam = z
	.string()
	.trim()
	.min(1, "Name the release the maps belong to.")
	.max(200);

export const redirectApiBody = z.object({
	destination: z.string().optional().meta({
		description: "The full http(s) URL to send requests to",
	}),
	enabled: z.boolean().optional(),
	keepPath: z.boolean().optional().meta({
		description:
			"Append the rest of the path and the query string to the destination",
	}),
	permanent: z.boolean().optional().meta({
		description: "308 when true, 307 otherwise",
	}),
	source: z.string().optional().meta({
		description:
			'A hostname with an optional path prefix, e.g. "old.example.com" or "example.com/blog"',
	}),
});

/** `POST /notifications/read`'s body: one notification to mark read, or none for all of them. */
export const markNotificationsReadApiBody = z.object({
	id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The notification to mark read. Omitted, every unread one is marked read.",
		),
});

const permissionsField = z
	.partialRecord(
		z.enum(PERMISSION_AREAS.map((area) => area.key)),
		z.enum(PERMISSION_LEVELS),
	)
	.meta({
		description:
			'Dashboard and API areas the account may use, each "read" or "write". None by default: the account\'s keys then only get through login walls that list it.',
	});

export const createServiceAccountApiBody = z.object({
	name: z.string().trim().min(1).max(100),
	permissions: permissionsField.optional(),
});

export const updateServiceAccountApiBody = z.object({
	disabled: z.boolean().optional().meta({
		description:
			"A disabled account's keys are refused, and the login-wall cookies it already holds stop working within five minutes",
	}),
	name: z.string().trim().min(1).max(100).optional(),
	permissions: permissionsField.optional(),
});

export const createServiceAccountKeyApiBody = z.object({
	expiresInDays: z.number().int().min(1).max(3650).nullable().optional().meta({
		description: "Days until the key expires; null never expires. Default 90",
	}),
	name: z.string().trim().min(1).max(100).optional(),
});
