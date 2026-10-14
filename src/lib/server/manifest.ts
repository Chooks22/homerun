import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { updateServiceApiBody } from "#lib/server/validation/api.js";

export const MANIFEST_FILES = [
	".homerun.json",
	".homerun.yaml",
	".homerun.yml",
] as const;

export const MANIFEST_SCHEMA_URL =
	"https://raw.githubusercontent.com/orochibraru/homerun/main/manifest.schema.json";

const BUILD_KEYS = [
	"gitBakeFile",
	"gitBuildContext",
	"gitBuildMethod",
	"gitBuildTarget",
	"gitDockerfilePath",
	"gitIgnorePaths",
	"gitWatchPaths",
] as const;

const IMAGE_KEYS = ["image", "pullPolicy", "tag"] as const;

const RUNTIME_KEYS = [
	"command",
	"containerPort",
	"cpuLimit",
	"entrypoint",
	"envVars",
	"healthcheckCommand",
	"healthcheckDisabled",
	"healthcheckIntervalSeconds",
	"healthcheckRetries",
	"healthcheckStartPeriodSeconds",
	"healthcheckTimeoutSeconds",
	"memoryLimitMb",
	"replicas",
	"restartPolicy",
	"runAsUser",
] as const;

const ROUTING_KEYS = [
	"defaultDomainEnabled",
	"dnsResolvable",
	"domainPorts",
	"domains",
	"httpCacheTtl",
	"portProtocol",
	"primaryDomain",
	"stripPathDomains",
] as const;

const ACCESS_KEYS = [
	"authAllowedEmails",
	"authAllowedGroups",
	"authAllowedUserIds",
	"authPaths",
	"authPathsMode",
	"authProviders",
	"authRequired",
	"blockedPaths",
] as const;

const PREVIEW_KEYS = [
	"previewAuthAllowedEmails",
	"previewAuthAllowedGroups",
	"previewAuthAllowedUserIds",
	"previewAuthProviders",
	"previewAuthRequired",
	"previewBranchExclude",
	"previewBranchInclude",
	"previewCopyVolumes",
	"previewDefaultDomain",
	"previewDomainTemplate",
	"previewEnvOverrides",
	"previewInheritEnv",
	"previewsEnabled",
] as const;

const SETTINGS_KEYS = [
	"autoRollback",
	"category",
	"cronEnabled",
	"cronSchedule",
	"icon",
	"imageScanEnabled",
	"name",
	"tracesEnabled",
	"uptimeEnabled",
] as const;

type ManifestKey =
	| (typeof BUILD_KEYS)[number]
	| (typeof IMAGE_KEYS)[number]
	| (typeof RUNTIME_KEYS)[number]
	| (typeof ROUTING_KEYS)[number]
	| (typeof ACCESS_KEYS)[number]
	| (typeof PREVIEW_KEYS)[number]
	| (typeof SETTINGS_KEYS)[number];

const MANIFEST_KEYS: readonly ManifestKey[] = [
	...BUILD_KEYS,
	...IMAGE_KEYS,
	...RUNTIME_KEYS,
	...ROUTING_KEYS,
	...ACCESS_KEYS,
	...PREVIEW_KEYS,
	...SETTINGS_KEYS,
];

const DESCRIPTIONS: Partial<Record<ManifestKey, string>> = {
	authAllowedEmails:
		"Addresses let through the login wall, exact or *@example.com for a whole domain. With an emailed sign-in method, leaving this and authAllowedUserIds empty lets any Homerun account through.",
	authAllowedGroups:
		"Group or role claims from the OAuth provider's id token, or Homerun roles (admin, developer, viewer, custom, app-user), let through the login wall.",
	authAllowedUserIds:
		"Homerun account ids let through the login wall, service accounts included (a service account only gets through when listed here).",
	authProviders:
		'Sign-in methods the login wall accepts. One or more of "password", "email-otp" (emailed code), "magic-link" (emailed link) and "oauth:<provider name>"; an emailed method must be switched on under Authentication, with SMTP configured.',
	authRequired: "Put the service behind Homerun's login wall.",
	autoRollback:
		"Roll back to the previous revision when a new one turns unhealthy.",
	category: "The service's category in the services list.",
	containerPort:
		"The port the app listens on inside the container, where Traefik sends its traffic.",
	cpuLimit: 'CPU limit in cores, e.g. "0.5"; null for none.',
	cronEnabled: "Redeploy on cronSchedule.",
	defaultDomainEnabled: "Also route the service at <slug>.<base domain>.",
	dnsResolvable:
		"Publish the service's hostnames through the instance's DNS automation.",
	domains:
		'Hostnames routed to the service. One may carry a path ("example.com/api") to route only that path and what\'s under it, even while another service has the bare hostname.',
	envVars:
		"Environment variables, merged into the service's environment: a variable set elsewhere and missing here is kept. Keep secrets out of the repository; set them on the dashboard.",
	gitBakeFile:
		"The Docker Bake file for the bake method, relative to the build context.",
	gitBuildContext:
		"The build context directory, relative to the repository root. The manifest is looked for there first, then at the root.",
	gitBuildMethod:
		"How the repository is built: a Dockerfile, a Docker Bake target, Nixpacks, Railpack, or Heroku or Paketo buildpacks.",
	gitBuildTarget: "The Bake target, or the Dockerfile stage to build.",
	gitDockerfilePath: "The Dockerfile, relative to the build context.",
	healthcheckCommand:
		"A shell command run inside the container to check it's healthy; null for the image's own.",
	healthcheckDisabled: "Turn the health check off, the image's own included.",
	healthcheckIntervalSeconds: "Seconds between health checks.",
	healthcheckRetries:
		"Failed checks in a row before the container counts as unhealthy.",
	healthcheckStartPeriodSeconds:
		"Seconds after start during which failures don't count.",
	healthcheckTimeoutSeconds: "Seconds a check may run.",
	httpCacheTtl:
		"Cache the service's responses at the edge for this many seconds; null to turn caching off.",
	icon: "The service's icon.",
	image:
		"The image to run, for a service that isn't built from its repository.",
	imageScanEnabled: "Scan the image for vulnerabilities on deploy.",
	memoryLimitMb: "Memory limit in MiB; null for none.",
	name: "The service's display name.",
	portProtocol: "Whether containerPort speaks TCP, UDP or both.",
	previewAuthAllowedEmails: "authAllowedEmails for pull request previews.",
	previewAuthAllowedGroups: "authAllowedGroups for pull request previews.",
	previewAuthAllowedUserIds:
		"authAllowedUserIds for pull request previews, e.g. a CI service account.",
	previewAuthProviders:
		'Sign-in methods the previews\' login wall accepts. One or more of "password", "email-otp" (emailed code), "magic-link" (emailed link) and "oauth:<provider name>"; an emailed method must be switched on under Authentication, with SMTP configured.',
	previewAuthRequired: "Put every pull request preview behind the login wall.",
	previewDefaultDomain: "Route previews at their default hostname.",
	previewDomainTemplate:
		"Hostname template for previews, e.g. pr-{pr}.example.com.",
	previewsEnabled: "Deploy a preview for every pull request.",
	primaryDomain: "The hostname shown and linked as the service's address.",
	pullPolicy: "When to pull image: always, only when missing, or never.",
	replicas: "How many replicas to run under swarm; 0 scales it to zero.",
	restartPolicy: "Docker's restart policy for the container.",
	tag: "The image tag to run.",
	tracesEnabled: "Collect OpenTelemetry traces from the service.",
	uptimeEnabled: "Probe the service's address for the uptime history.",
};

export const manifestSchema = z
	.object(
		Object.fromEntries(
			MANIFEST_KEYS.map((key) => {
				const field = updateServiceApiBody.shape[key];
				const description = DESCRIPTIONS[key];
				return [key, description ? field.meta({ description }) : field];
			}),
		) as Pick<(typeof updateServiceApiBody)["shape"], ManifestKey>,
	)
	.extend({
		$schema: z.string().optional().meta({
			description: "The JSON schema this file follows, for editor support",
		}),
	})
	.strict()
	.meta({
		description:
			"A Homerun Manifest: a service's configuration, kept as .homerun.json (or .homerun.yaml / .homerun.yml) in its repository and applied on every deploy, or applied to any service with `homerun manifest apply`. Every key is optional and uses the REST API's field name; keys left out keep their current value, and envVars are merged into the service's environment rather than replacing it.",
		title: "Homerun Manifest",
	});

export type Manifest = z.infer<typeof manifestSchema>;

export type ManifestInput = Omit<Manifest, "$schema">;

/** Which parts of a manifest a service takes: everything, or only how it's built and run (a pull request preview or a release channel canary). */
export type ManifestScope = "full" | "build-runtime";

/**
 * Parses a manifest's text, as YAML when `fileName` ends in `.yaml` or
 * `.yml` and as JSON otherwise, and validates it.
 *
 * @returns The manifest without its `$schema` key, or every problem found,
 * each prefixed with the key it's about.
 */
export function parseManifest(
	text: string,
	fileName: string,
): { manifest: ManifestInput } | { errors: string[] } {
	let raw: unknown;
	try {
		raw = /\.ya?ml$/i.test(fileName) ? parseYaml(text) : JSON.parse(text);
	} catch (error) {
		return {
			errors: [
				`${fileName} isn't valid ${/\.ya?ml$/i.test(fileName) ? "YAML" : "JSON"}: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
	const parsed = manifestSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map((issue) =>
				issue.path.length > 0
					? `${issue.path.join(".")}: ${issue.message}`
					: issue.message,
			),
		};
	}
	const { $schema: _schema, ...manifest } = parsed.data;
	return { manifest };
}

/**
 * The part of `manifest` a service applies: everything for `full`, only the
 * build and runtime keys for `build-runtime`. Image keys are dropped for a
 * service built from its repository, where they mean nothing.
 *
 * @returns The keys to apply, and the keys left out.
 */
export function manifestFields(
	manifest: ManifestInput,
	scope: ManifestScope,
	builtFromRepo: boolean,
): { fields: ManifestInput; ignored: string[] } {
	const allowed = new Set<string>(
		scope === "full"
			? MANIFEST_KEYS
			: [...BUILD_KEYS, ...IMAGE_KEYS, ...RUNTIME_KEYS],
	);
	if (builtFromRepo) {
		for (const key of IMAGE_KEYS) {
			allowed.delete(key);
		}
	}
	const fields: Record<string, unknown> = {};
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(manifest)) {
		if (allowed.has(key)) {
			fields[key] = value;
		} else {
			ignored.push(key);
		}
	}
	return { fields: fields as ManifestInput, ignored };
}

/**
 * The manifest file paths to look for in a repository, nearest first: next to
 * the build context when it isn't the repository root, then at the root.
 */
export function manifestPaths(buildContext: string | null): string[] {
	const context = (buildContext ?? "")
		.trim()
		.replace(/^\.?\/+/, "")
		.replace(/\/+$/, "");
	const nested =
		context && context !== "."
			? MANIFEST_FILES.map((file) => `${context}/${file}`)
			: [];
	return [...nested, ...MANIFEST_FILES];
}

/** The manifest's JSON schema, as published at the repository root and served by every instance. */
export function manifestJsonSchema(): Record<string, unknown> {
	return {
		$id: MANIFEST_SCHEMA_URL,
		...(z.toJSONSchema(manifestSchema, { target: "draft-7" }) as Record<
			string,
			unknown
		>),
	};
}

/**
 * Parses a request body as a manifest: YAML when the request's content type
 * says so (`application/yaml`, `text/yaml`, `application/x-yaml`), JSON
 * otherwise.
 */
export async function manifestFromRequest(
	request: Request,
): Promise<{ manifest: ManifestInput } | { errors: string[] }> {
	const type = request.headers.get("content-type") ?? "";
	return parseManifest(
		await request.text(),
		/yaml/i.test(type) ? "manifest.yaml" : "manifest.json",
	);
}
