import { describe, expect, test } from "bun:test";
import type { Service } from "#lib/server/db/schema.js";
import { serviceConfig, serviceConfigSchema } from "#lib/service-config.js";

function row(overrides: Partial<Service> = {}): Service {
	return {
		authAllowedEmails: [],
		authAllowedGroups: [],
		authAllowedUserIds: [],
		authPaths: [],
		authPathsMode: "all",
		authProviders: [],
		authRequired: false,
		blockedPaths: [],
		autoDeployOnPush: false,
		autoRollback: true,
		buildCacheRegistryId: null,
		buildServerRemoteHostId: null,
		buildSource: "image",
		capAdd: [],
		category: "database",
		command: null,
		containerPort: 5432,
		cpuLimit: "1",
		cronEnabled: false,
		cronSchedule: null,
		customSslCertEnc: "cert-ciphertext",
		customSslKeyEnc: "key-ciphertext",
		defaultDomainEnabled: true,
		devices: [],
		dnsResolvable: false,
		domainPorts: {},
		domains: [],
		entrypoint: null,
		envFiles: [],
		envVars: { POSTGRES_DB: "app" },
		secretEnvKeys: [],
		gitBakeFile: null,
		gitBuildTarget: null,
		gitBuildContext: null,
		gitBuildMethod: "dockerfile",
		gitDockerfilePath: null,
		gitPollEnabled: false,
		gitRef: null,
		gitUrl: null,
		healthcheckCommand: null,
		healthcheckDisabled: false,
		healthcheckIntervalSeconds: null,
		healthcheckRetries: null,
		healthcheckStartPeriodSeconds: null,
		healthcheckTimeoutSeconds: null,
		httpCacheTtl: null,
		icon: "data:image/png;base64,AAAA",
		id: "svc-1",
		image: "postgres",
		imageScanEnabled: true,
		labels: {},
		memoryLimitMb: 512,
		name: "DB",
		networkMode: "bridge",
		portProtocol: "tcp",
		previewBranchExclude: [],
		previewBranchInclude: [],
		previewDefaultDomain: true,
		previewDomainTemplate: null,
		previewsEnabled: false,
		primaryDomain: null,
		privileged: false,
		runAsUser: null,
		publishedPorts: [{ containerPort: 5432, hostPort: 5432, protocol: "tcp" }],
		pullPolicy: "always",
		registryPasswordEnc: "password-ciphertext",
		registryUrl: "ghcr.io",
		registryUsername: "me",
		replicas: 1,
		requireStatusChecks: false,
		requiredStatusChecks: [],
		restartPolicy: "unless-stopped",
		slug: "db",
		stripPathDomains: [],
		tag: "18",
		uptimeEnabled: true,
		...overrides,
	} as unknown as Service;
}

const extras = {
	mounts: [
		{
			containerPath: "/var/lib/postgresql/data",
			kind: "volume",
			name: "db-data",
			readOnly: false,
			source: "db-data",
		},
	],
	stack: { id: "stack-1", name: "App" },
};

describe("serviceConfig", () => {
	test("groups the settings by tab and matches the published schema", () => {
		const config = serviceConfig(row(), extras);
		expect(serviceConfigSchema.safeParse(config).success).toBe(true);
		expect(config.networking.publishedPorts).toHaveLength(1);
		expect(config.volumes[0]?.containerPath).toBe("/var/lib/postgresql/data");
		expect(config.settings.stack).toEqual({ id: "stack-1", name: "App" });
		expect(config.source.git).toBeNull();
	});

	test("shows an image-based service's preview settings", () => {
		const config = serviceConfig(row({ previewsEnabled: true }), extras);
		expect(config.source.git).toBeNull();
		expect(config.source.previewsEnabled).toBe(true);
	});

	test("never leaks a secret or an uploaded image", () => {
		const text = JSON.stringify(serviceConfig(row(), extras));
		expect(text).not.toContain("ciphertext");
		expect(text).not.toContain("data:image");
		const config = serviceConfig(row(), extras);
		expect(config.source.registry.passwordSet).toBe(true);
		expect(config.networking.customSsl).toBe(true);
		expect(config.settings.icon).toBe("uploaded");
	});

	test("fills in git settings only for a git-built service", () => {
		const config = serviceConfig(
			row({ buildSource: "git", gitRef: "main", gitUrl: "https://x/y.git" }),
			extras,
		);
		expect(config.source.git?.url).toBe("https://x/y.git");
		expect(config.source.git?.ref).toBe("main");
	});
});
