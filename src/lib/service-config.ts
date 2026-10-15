import { z } from "zod";
import { AUTH_PATHS_MODES } from "#lib/path-patterns.js";
import { deployEnvironment } from "#lib/release-channels.js";
import type { Service } from "#lib/server/db/schema.js";

const argv = z.array(z.string()).nullable();

export const serviceConfigSchema = z.object({
	compute: z.object({
		cpuLimit: z.string().nullable(),
		memoryLimitMb: z.number().int().nullable(),
		replicas: z.number().int(),
		restartPolicy: z.string(),
	}),
	env: z.object({
		buildKeys: z.array(z.string()),
		files: z.array(z.string()),
		secretKeys: z.array(z.string()),
		vars: z.record(z.string(), z.string()),
	}),
	id: z.string(),
	name: z.string(),
	networking: z.object({
		containerPort: z.number().int(),
		customSsl: z.boolean(),
		defaultDomainEnabled: z.boolean(),
		dnsResolvable: z.boolean(),
		domainPorts: z.record(z.string(), z.number().int()),
		domains: z.array(z.string()),
		httpCacheTtl: z.number().int().nullable(),
		networkMode: z.enum(["bridge", "host"]),
		portProtocol: z.enum(["tcp", "udp", "both"]),
		primaryDomain: z.string().nullable(),
		stripPathDomains: z.array(z.string()),
		publishedPorts: z.array(
			z.object({
				containerPort: z.number().int(),
				hostPort: z.number().int(),
				protocol: z.enum(["tcp", "udp"]),
			}),
		),
	}),
	runtime: z.object({
		capAdd: z.array(z.string()),
		command: argv,
		devices: z.array(z.string()),
		entrypoint: argv,
		healthcheck: z.object({
			command: z.string().nullable(),
			disabled: z.boolean(),
			intervalSeconds: z.number().int().nullable(),
			retries: z.number().int().nullable(),
			startPeriodSeconds: z.number().int().nullable(),
			timeoutSeconds: z.number().int().nullable(),
		}),
		labels: z.record(z.string(), z.string()),
		privileged: z.boolean(),
		runAsUser: z.string().nullable(),
	}),
	security: z.object({
		allowedEmails: z.array(z.string()),
		allowedGroups: z.array(z.string()),
		allowedUserIds: z.array(z.string()),
		blockedPaths: z.array(z.string()),
		imageScanEnabled: z.boolean(),
		loginPaths: z.array(z.string()),
		loginPathsMode: z.enum(AUTH_PATHS_MODES),
		loginProviders: z.array(z.string()),
		loginRequired: z.boolean(),
	}),
	settings: z.object({
		autoRedeploy: z.object({
			enabled: z.boolean(),
			schedule: z.string().nullable(),
		}),
		autoRollback: z.boolean(),
		category: z.string().nullable(),
		environment: z.string().meta({
			description:
				"The environment its deployments are recorded under: production unless renamed, canary or preview for a child service.",
		}),
		icon: z.string().nullable().meta({
			description:
				'A bundled template icon file name, "uploaded" for a custom image, or null.',
		}),
		stack: z.object({ id: z.string(), name: z.string() }).nullable(),
		uptimeEnabled: z.boolean(),
	}),
	slug: z.string(),
	source: z.object({
		buildSource: z.enum(["image", "git"]),
		git: z
			.object({
				autoDeployOnPush: z.boolean(),
				bakeFile: z.string().nullable(),
				buildTarget: z.string().nullable(),
				buildCacheBuiltin: z.boolean(),
				buildCacheRegistryId: z.string().nullable(),
				buildContext: z.string().nullable(),
				buildMethod: z.string(),
				buildServerRemoteHostId: z.string().nullable(),
				dockerfilePath: z.string().nullable(),
				ignorePaths: z.array(z.string()),
				pollEnabled: z.boolean(),
				ref: z.string().nullable(),
				requireStatusChecks: z.boolean(),
				requiredStatusChecks: z.array(z.string()),
				url: z.string().nullable(),
				watchPaths: z.array(z.string()),
			})
			.nullable(),
		image: z.string(),
		previewBranchExclude: z.array(z.string()),
		previewBranchInclude: z.array(z.string()),
		previewsEnabled: z.boolean(),
		pullPolicy: z.string(),
		registry: z.object({
			passwordSet: z.boolean(),
			url: z.string().nullable(),
			username: z.string().nullable(),
		}),
		tag: z.string(),
	}),
	volumes: z.array(
		z.object({
			containerPath: z.string(),
			kind: z.string(),
			name: z.string(),
			readOnly: z.boolean(),
			source: z.string(),
		}),
	),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export interface ServiceConfigMount {
	containerPath: string;
	kind: string;
	name: string;
	readOnly: boolean;
	source: string;
}

function securityConfig(row: Service): ServiceConfig["security"] {
	return {
		allowedEmails: row.authAllowedEmails,
		allowedGroups: row.authAllowedGroups,
		allowedUserIds: row.authAllowedUserIds,
		blockedPaths: row.blockedPaths,
		imageScanEnabled: row.imageScanEnabled,
		loginPaths: row.authPaths,
		loginPathsMode: row.authPathsMode,
		loginProviders: row.authProviders,
		loginRequired: row.authRequired,
	};
}

/**
 * A service's settings grouped the way the dashboard's tabs group them, for
 * `GET /services/{id}/config` and `homerun services config`. Secrets never
 * appear: an encrypted registry password or SSL key becomes a boolean, and an
 * uploaded icon becomes "uploaded" rather than its data URL.
 */
export function serviceConfig(
	row: Service,
	extras: {
		mounts: ServiceConfigMount[];
		stack: { id: string; name: string } | null;
	},
): ServiceConfig {
	return {
		compute: {
			cpuLimit: row.cpuLimit,
			memoryLimitMb: row.memoryLimitMb,
			replicas: row.replicas,
			restartPolicy: row.restartPolicy,
		},
		env: {
			buildKeys: row.buildEnvKeys,
			files: row.envFiles,
			secretKeys: row.secretEnvKeys,
			vars: row.envVars ?? {},
		},
		id: row.id,
		name: row.name,
		networking: {
			containerPort: row.containerPort,
			customSsl: Boolean(row.customSslCertEnc && row.customSslKeyEnc),
			defaultDomainEnabled: row.defaultDomainEnabled,
			dnsResolvable: row.dnsResolvable,
			domainPorts: row.domainPorts,
			domains: row.domains,
			httpCacheTtl: row.httpCacheTtl,
			networkMode: row.networkMode,
			portProtocol: row.portProtocol,
			primaryDomain: row.primaryDomain,
			stripPathDomains: row.stripPathDomains,
			publishedPorts: row.publishedPorts,
		},
		runtime: {
			capAdd: row.capAdd,
			command: row.command,
			devices: row.devices,
			entrypoint: row.entrypoint,
			healthcheck: {
				command: row.healthcheckCommand,
				disabled: row.healthcheckDisabled,
				intervalSeconds: row.healthcheckIntervalSeconds,
				retries: row.healthcheckRetries,
				startPeriodSeconds: row.healthcheckStartPeriodSeconds,
				timeoutSeconds: row.healthcheckTimeoutSeconds,
			},
			labels: row.labels,
			privileged: row.privileged,
			runAsUser: row.runAsUser,
		},
		security: securityConfig(row),
		settings: {
			autoRedeploy: { enabled: row.cronEnabled, schedule: row.cronSchedule },
			autoRollback: row.autoRollback,
			category: row.category,
			environment: deployEnvironment(row),
			icon: row.icon?.startsWith("data:") ? "uploaded" : row.icon,
			stack: extras.stack,
			uptimeEnabled: row.uptimeEnabled,
		},
		slug: row.slug,
		source: {
			buildSource: row.buildSource,
			git:
				row.buildSource === "git"
					? {
							autoDeployOnPush: row.autoDeployOnPush,
							bakeFile: row.gitBakeFile,
							buildTarget: row.gitBuildTarget,
							buildCacheBuiltin: row.buildCacheBuiltin,
							buildCacheRegistryId: row.buildCacheRegistryId,
							buildContext: row.gitBuildContext,
							buildMethod: row.gitBuildMethod,
							buildServerRemoteHostId: row.buildServerRemoteHostId,
							dockerfilePath: row.gitDockerfilePath,
							ignorePaths: row.gitIgnorePaths,
							pollEnabled: row.gitPollEnabled,
							ref: row.gitRef,
							requireStatusChecks: row.requireStatusChecks,
							requiredStatusChecks: row.requiredStatusChecks,
							url: row.gitUrl,
							watchPaths: row.gitWatchPaths,
						}
					: null,
			image: row.image,
			previewBranchExclude: row.previewBranchExclude,
			previewBranchInclude: row.previewBranchInclude,
			previewsEnabled: row.previewsEnabled,
			pullPolicy: row.pullPolicy,
			registry: {
				passwordSet: Boolean(row.registryPasswordEnc),
				url: row.registryUrl,
				username: row.registryUsername,
			},
			tag: row.tag,
		},
		volumes: extras.mounts,
	};
}
