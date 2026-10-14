import type { BuildMethod } from "#lib/build-methods.js";
import type { AuthPathsMode } from "#lib/path-patterns.js";
import type { PublishedPort } from "#lib/published-ports.js";
import type { Service } from "#lib/server/db/schema.js";
import type { runtimeOptionsFrom } from "#lib/service-runtime.js";
import type { PullPolicy } from "#lib/types.js";

/** Fields a caller supplies to insert a new service row. */
export interface NewServiceInput {
	authPaths?: string[];
	authPathsMode?: AuthPathsMode;
	authRequired?: boolean;
	blockedPaths?: string[];
	/** Off by default for a database or cache image, which has no HTTP to probe and no public route to watch. */
	uptimeEnabled?: boolean;
	buildCacheRegistryId?: string | null;
	buildCacheBuiltin?: boolean;
	buildServerRemoteHostId?: string | null;
	buildSource?: "image" | "git";
	containerPort: number;
	cpuLimit?: string | null;
	dnsResolvable?: boolean;
	domains?: string[];
	stripPathDomains?: string[];
	envVars: Record<string, string>;
	secretEnvKeys?: string[];
	gitBakeFile?: string | null;
	gitBuildTarget?: string | null;
	gitBuildContext?: string | null;
	gitBuildMethod?: BuildMethod;
	gitDockerfilePath?: string | null;
	gitRef?: string | null;
	gitUrl?: string | null;
	gitProviderId?: string | null;
	gitRepo?: string | null;
	autoDeployOnPush?: boolean;
	gitIgnorePaths?: string[];
	gitWatchPaths?: string[];
	healthcheckCommand?: string | null;
	healthcheckDisabled?: boolean;
	healthcheckIntervalSeconds?: number | null;
	healthcheckRetries?: number | null;
	healthcheckStartPeriodSeconds?: number | null;
	healthcheckTimeoutSeconds?: number | null;
	previewBranch?: string | null;
	channelCanary?: boolean;
	previewParentId?: string | null;
	previewPrNumber?: number | null;
	previewPrTitle?: string | null;
	image: string;
	runtime?: Parameters<typeof runtimeOptionsFrom>[0];
	memoryLimitMb?: number | null;
	name: string;
	networkMode?: "bridge" | "host";
	portProtocol?: "tcp" | "udp" | "both";
	publishedPorts?: PublishedPort[];
	category?: string | null;
	icon?: string | null;
	stackId?: string | null;
	registryPasswordEnc?: string | null;
	registryUrl?: string | null;
	registryUsername?: string | null;
	pullPolicy?: PullPolicy;
	replicas?: number;
	restartPolicy: string;
	slug: string;
	tag: string;
	userId: string;
}

/** Fields a caller may patch on an existing service row. */
export type ServiceUpdateInput = Partial<
	Pick<
		Service,
		| "authAllowedEmails"
		| "authAllowedGroups"
		| "authAllowedUserIds"
		| "authPaths"
		| "authPathsMode"
		| "authProviders"
		| "authRequired"
		| "blockedPaths"
		| "autoRollback"
		| "buildCacheRegistryId"
		| "buildCacheBuiltin"
		| "buildServerRemoteHostId"
		| "buildSource"
		| "containerId"
		| "containerPort"
		| "cpuLimit"
		| "cronEnabled"
		| "cronLastRunAt"
		| "cronSchedule"
		| "currentStatus"
		| "defaultDomainEnabled"
		| "domains"
		| "stripPathDomains"
		| "primaryDomain"
		| "customSslCertEnc"
		| "customSslKeyEnc"
		| "desiredState"
		| "dnsResolvable"
		| "envVars"
		| "secretEnvKeys"
		| "errorsDismissedAt"
		| "errorsDismissedByDeploymentId"
		| "gitBakeFile"
		| "gitBuildTarget"
		| "gitBuildContext"
		| "gitBuildMethod"
		| "gitDockerfilePath"
		| "gitRef"
		| "gitUrl"
		| "gitProviderId"
		| "gitRepo"
		| "autoDeployOnPush"
		| "gitIgnorePaths"
		| "gitWatchPaths"
		| "gitWebhookId"
		| "gitWebhookSecretEnc"
		| "gitWebhookError"
		| "gitWebhookReconnect"
		| "gitPollEnabled"
		| "gitLastSeenCommit"
		| "previewsEnabled"
		| "previewPrTitle"
		| "previewAuthAllowedEmails"
		| "previewAuthAllowedGroups"
		| "previewAuthAllowedUserIds"
		| "previewAuthProviders"
		| "previewAuthRequired"
		| "previewDefaultDomain"
		| "previewReportGithub"
		| "previewBranchExclude"
		| "previewCopyVolumes"
		| "previewEnvOverrides"
		| "previewInheritEnv"
		| "previewBranchInclude"
		| "previewDomainTemplate"
		| "previewBranch"
		| "channelsEnabled"
		| "channelBranch"
		| "channelTagPattern"
		| "channelCanaryDomain"
		| "environmentName"
		| "healthcheckCommand"
		| "healthcheckDisabled"
		| "healthcheckIntervalSeconds"
		| "healthcheckRetries"
		| "healthcheckStartPeriodSeconds"
		| "healthcheckTimeoutSeconds"
		| "image"
		| "imageScanEnabled"
		| "memoryLimitMb"
		| "name"
		| "networkMode"
		| "portProtocol"
		| "category"
		| "httpCacheTtl"
		| "icon"
		| "domainPorts"
		| "publishedPorts"
		| "stackId"
		| "pullPolicy"
		| "registryPasswordEnc"
		| "registryUrl"
		| "registryUsername"
		| "replicas"
		| "requireStatusChecks"
		| "requiredStatusChecks"
		| "restartPolicy"
		| "slug"
		| "swarmServiceId"
		| "tracesEnabled"
		| "uptimeEnabled"
		| "tag"
		| "pinnedFromTag"
		| "pinnedLocally"
		| "updateCheck"
		| "updateCheckEnabled"
		| "updateTrialEnabled"
	>
> &
	Parameters<typeof runtimeOptionsFrom>[0];

/** The version-pinning and update-check columns of a new service: not pinned, not watching for updates, trials on for when it does. */
export const NEW_SERVICE_VERSION_COLUMNS: Pick<
	Service,
	| "pinnedFromTag"
	| "pinnedLocally"
	| "updateCheck"
	| "updateCheckEnabled"
	| "updateTrialEnabled"
> = {
	pinnedFromTag: null,
	pinnedLocally: false,
	updateCheck: null,
	updateCheckEnabled: false,
	updateTrialEnabled: true,
};
