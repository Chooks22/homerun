import {
	IAC_IDENTITY_RESOURCES,
	loginWallAttributes,
} from "#lib/iac/resources-identity.js";
import { infrastructureResources } from "#lib/iac/resources-infrastructure.js";
import { IAC_SETTINGS_RESOURCES } from "#lib/iac/resources-settings.js";
import * as versions from "#lib/iac/resources-versions.js";
import { PERMISSION_AREAS, PERMISSION_LEVELS } from "#lib/permissions.js";

export type IacKind =
	| "bool"
	| "int"
	| "intMap"
	| "objects"
	| "string"
	| "stringMap"
	| "strings";

export interface IacAttribute {
	/** Sent on create only and never read back; changing it replaces the resource. */
	createOnly?: boolean;
	default?: unknown;
	description?: string;
	fields?: IacAttribute[];
	forceNew?: boolean;
	kind: IacKind;
	/** The REST API's JSON field. */
	name: string;
	readOnly?: boolean;
	/** The resource type whose id this attribute holds, for references in generated configuration. */
	ref?: string;
	required?: boolean;
	/** Read-only and only in the create response (a generated secret): every read keeps the value the create stored. */
	returnedOnCreate?: boolean;
	sensitive?: boolean;
	/** The Terraform attribute name: snake_case of `name`, unless that's one Terraform reserves. */
	tf: string;
	/** Accepted on write, never returned by the API. */
	writeOnly?: boolean;
}

export interface IacResource {
	adminOnly?: boolean;
	attributes: IacAttribute[];
	collectionPath: string;
	/** Whether the resource has a `deploy_on_change` switch deploying it after a create or an update. */
	deployable?: boolean;
	description: string;
	/** Attributes joined with "/" to form the import id, `["id"]` unless the id is composite. */
	importId: string[];
	itemPath: string;
	/** The attribute naming the object in generated configuration. */
	label: string;
	/** One object at a fixed `itemPath`, never created or deleted through the API: create adopts it and applies the configuration (a PATCH), delete only drops it from the state, and its id is always `SINGLETON_ID` (resources-settings.ts). */
	singleton?: boolean;
	type: string;
}

export interface IacDataSource {
	collectionPath: string;
	description: string;
	itemPath: string;
	/** Attributes besides `id` the data source can look an object up by, through the list endpoint's search. */
	lookup: string[];
	resource?: string;
	attributes?: IacAttribute[];
	type: string;
}

type AttributeOptions = Omit<Partial<IacAttribute>, "kind" | "name">;

/** snake_case of a camelCase API field, the attribute name Terraform sees. */
export function toSnakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function attr(
	name: string,
	kind: IacKind,
	options: AttributeOptions = {},
): IacAttribute {
	return { kind, name, tf: toSnakeCase(name), ...options };
}

const required = { required: true };
const secret = { sensitive: true, writeOnly: true };
const replace = { forceNew: true, required: true };
const off = { default: false };
const on = { default: true };
const templated = { description: "Required unless template_id is set." };

const publishedPortFields = [
	attr("containerPort", "int", required),
	attr("hostPort", "int", required),
	attr("protocol", "string", { default: "tcp" }),
];

const serviceAttributes: IacAttribute[] = [
	attr("name", "string", templated),
	attr("slug", "string", {
		description:
			"Subdomain and container name, unique. Required unless template_id is set.",
	}),
	attr("stackId", "string", { ref: "homerun_stack" }),
	attr("templateId", "string", {
		createOnly: true,
		description:
			"Create the service from this template (its image, variables, volumes and linked services), then apply the other attributes. Changing it replaces the service, unless it was imported without one.",
	}),
	attr("buildSource", "string", {
		default: "image",
		description: "image or git.",
	}),
	attr("image", "string"),
	attr("tag", "string", { default: "latest" }),
	attr("pullPolicy", "string", { default: "always" }),
	...versions.versionAttributes(attr),
	attr("registryUrl", "string"),
	attr("registryUsername", "string"),
	attr("registryPassword", "string", secret),
	attr("registryPasswordSet", "bool", { readOnly: true }),
	attr("gitUrl", "string"),
	attr("gitRef", "string"),
	attr("gitProviderId", "string", { ref: "homerun_git_provider" }),
	attr("gitRepo", "string"),
	attr("gitBuildMethod", "string", { default: "dockerfile" }),
	attr("gitBuildContext", "string"),
	attr("gitDockerfilePath", "string"),
	attr("gitBakeFile", "string"),
	attr("gitBuildTarget", "string"),
	attr("autoDeployOnPush", "bool", off),
	attr("gitPollEnabled", "bool", off),
	attr("gitWatchPaths", "strings", {
		description:
			"Repo path globs a push has to change a file under to deploy. Empty lets every file through.",
	}),
	attr("gitIgnorePaths", "strings", {
		description: "Repo path globs whose changes alone never deploy on push.",
	}),
	attr("requireStatusChecks", "bool", off),
	attr("requiredStatusChecks", "strings"),
	attr("buildCacheBuiltin", "bool", {
		...off,
		description: "Use the built-in registry as the build cache.",
	}),
	attr("buildCacheRegistryId", "string", {
		ref: "homerun_build_cache_registry",
	}),
	attr("buildServerRemoteHostId", "string"),
	attr("envVars", "stringMap", { sensitive: true }),
	attr("secretEnvKeys", "strings"),
	attr("buildEnvKeys", "strings"),
	attr("envFiles", "strings"),
	attr("cpuLimit", "string"),
	attr("memoryLimitMb", "int"),
	attr("replicas", "int", { default: 1 }),
	attr("scaleToZeroMinutes", "int"),
	attr("restartPolicy", "string", { default: "unless-stopped" }),
	attr("containerPort", "int", templated),
	attr("portProtocol", "string", { default: "tcp" }),
	attr("networkMode", "string", { default: "bridge" }),
	attr("dnsResolvable", "bool", {
		...on,
		description: "Public routing through Traefik.",
	}),
	attr("defaultDomainEnabled", "bool", on),
	attr("domains", "strings", {
		description:
			"Custom domains. One may carry a path (example.com/api) to route only that path and what's under it.",
	}),
	attr("primaryDomain", "string"),
	attr("domainPorts", "intMap"),
	attr("stripPathDomains", "strings", {
		description:
			"Domains with a path whose prefix is stripped before the request reaches the container (/api/v2 arrives as /v2).",
	}),
	attr("httpCacheTtl", "int"),
	attr("publishedPorts", "objects", { fields: publishedPortFields }),
	attr("customSslCert", "string", secret),
	attr("customSslKey", "string", secret),
	attr("customSslSet", "bool", { readOnly: true }),
	attr("command", "strings"),
	attr("entrypoint", "strings"),
	attr("capAdd", "strings"),
	attr("devices", "strings"),
	attr("labels", "stringMap"),
	attr("privileged", "bool", off),
	attr("runAsUser", "string"),
	attr("healthcheckCommand", "string"),
	attr("healthcheckDisabled", "bool", off),
	attr("healthcheckIntervalSeconds", "int"),
	attr("healthcheckRetries", "int"),
	attr("healthcheckStartPeriodSeconds", "int"),
	attr("healthcheckTimeoutSeconds", "int"),
	attr("authRequired", "bool", {
		...off,
		description: "Put the login wall in front of the app.",
	}),
	...loginWallAttributes("auth"),
	attr("authPathsMode", "string", { default: "all" }),
	attr("authPaths", "strings"),
	attr("blockedPaths", "strings"),
	attr("imageScanEnabled", "bool", on),
	attr("previewsEnabled", "bool", off),
	attr("previewBranchInclude", "strings"),
	attr("previewBranchExclude", "strings"),
	attr("previewInheritEnv", "bool", on),
	attr("previewUptimeEnabled", "bool", {
		...off,
		description:
			"Probe each pull request preview's uptime. Applied when a preview is created or redeployed.",
	}),
	attr("previewEnvOverrides", "stringMap"),
	attr("previewCopyVolumes", "bool", off),
	attr("previewReportGithub", "bool", on),
	attr("previewDefaultDomain", "bool", on),
	attr("previewDomainTemplate", "string"),
	attr("previewAuthRequired", "bool", off),
	...loginWallAttributes("previewAuth"),
	attr("channelsEnabled", "bool", {
		...off,
		description: "Release channels: a canary built from channel_branch.",
	}),
	attr("channelBranch", "string"),
	attr("channelTagPattern", "string", { default: "v*" }),
	attr("channelCanaryDomain", "string"),
	attr("environmentName", "string"),
	attr("autoRollback", "bool", off),
	attr("uptimeEnabled", "bool"),
	attr("tracesEnabled", "bool", off),
	attr("cronEnabled", "bool", {
		...off,
		description: "Redeploy on cron_schedule.",
	}),
	attr("cronSchedule", "string"),
	attr("category", "string"),
	attr("icon", "string"),
];

export const IAC_RESOURCES: IacResource[] = [
	{
		attributes: [
			attr("name", "string", required),
			attr("slug", "string", required),
			attr("description", "string"),
			attr("parentId", "string", {
				description: "The stack this one is nested in.",
				ref: "homerun_stack",
			}),
			attr("icon", "string"),
		],
		collectionPath: "/stacks",
		description: "A stack: a group of services sharing a network.",
		importId: ["id"],
		itemPath: "/stacks/{id}",
		label: "slug",
		type: "homerun_stack",
	},
	{
		attributes: serviceAttributes,
		collectionPath: "/services",
		deployable: true,
		description:
			"A service: one container (or swarm service) and every setting the dashboard shows for it.",
		importId: ["id"],
		itemPath: "/services/{id}",
		label: "slug",
		type: "homerun_service",
	},
	{
		attributes: [
			attr("serviceId", "string", { ...replace, ref: "homerun_service" }),
			attr("name", "string", replace),
			attr("ref", "string", {
				...required,
				description: "Branch or tag (git) or image tag the environment runs.",
			}),
			attr("domain", "string"),
			attr("envOverrides", "stringMap", {
				description: "Variables set on top of the copied ones.",
				...secret,
			}),
			attr("slug", "string", { readOnly: true }),
		],
		collectionPath: "/service-environments",
		deployable: true,
		description:
			"An environment of a service (staging, demo...): a copy of it running another branch or tag.",
		importId: ["id"],
		itemPath: "/service-environments/{id}",
		label: "slug",
		type: "homerun_service_environment",
	},
	{
		attributes: [
			attr("serviceId", "string", { ...replace, ref: "homerun_service" }),
			attr("dependsOnId", "string", { ...replace, ref: "homerun_service" }),
		],
		collectionPath: "/service-dependencies",
		description: "One service depending on another, started before it.",
		importId: ["id"],
		itemPath: "/service-dependencies/{id}",
		label: "id",
		type: "homerun_service_dependency",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("kind", "string", {
				...replace,
				description: "bind (a host path) or volume (a Docker volume).",
			}),
			attr("source", "string", {
				...replace,
				description: "The host path, or the Docker volume's name.",
			}),
			attr("description", "string"),
			attr("backupEnabled", "bool", off),
			attr("backupSchedule", "string"),
			attr("backupPrefix", "string"),
			attr("backupKeep", "int"),
			attr("s3DestinationId", "string", {
				ref: "homerun_backup_destination",
			}),
			attr("backupStopServices", "bool", off),
			attr("backupPreCommand", "string"),
			attr("backupPreCommandServiceId", "string", { ref: "homerun_service" }),
		],
		collectionPath: "/volumes",
		description: "A storage volume and its backup settings.",
		importId: ["id"],
		itemPath: "/volumes/{id}",
		label: "name",
		type: "homerun_volume",
	},
	{
		attributes: [
			attr("serviceId", "string", { ...replace, ref: "homerun_service" }),
			attr("volumeId", "string", { ...replace, ref: "homerun_volume" }),
			attr("containerPath", "string", required),
			attr("readOnly", "bool", off),
		],
		collectionPath: "/volume-mounts",
		description: "A volume mounted into a service, applied on its next deploy.",
		importId: ["id"],
		itemPath: "/volume-mounts/{id}",
		label: "containerPath",
		type: "homerun_volume_mount",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("kind", "string", {
				...replace,
				description:
					"image (a container), script (source code on a runtime image) or exec (a host command, needs write access to System).",
			}),
			attr("schedule", "string", required),
			attr("enabled", "bool", off),
			attr("description", "string"),
			attr("command", "string"),
			attr("image", "string"),
			attr("tag", "string", { default: "latest" }),
			attr("runtime", "string", {
				description:
					"A script job's runtime: bun, node, deno, python or shell.",
			}),
			attr("source", "string", { description: "A script job's source code." }),
			attr("envVars", "stringMap", { sensitive: true }),
			attr("secretEnvKeys", "strings"),
			attr("files", "objects", {
				description: "Text files written into the container before it starts.",
				fields: [
					attr("path", "string", required),
					attr("content", "string", required),
					attr("mode", "string", {
						description: "Octal permissions set after writing it, like 600.",
					}),
				],
			}),
			attr("mounts", "objects", {
				description:
					"Storage volumes mounted into the container, on this host only.",
				fields: [
					attr("volumeId", "string", required),
					attr("containerPath", "string", required),
					attr("readOnly", "bool", off),
				],
			}),
			attr("runAsUser", "string", {
				description:
					"Docker User (uid, uid:gid, name or name:group), unset keeps the image's.",
			}),
			attr("dockerSocket", "bool", {
				...off,
				description:
					"Mount the Docker socket at /var/run/docker.sock, needs write access to System.",
			}),
			attr("registryUrl", "string"),
			attr("registryUsername", "string"),
			attr("registryPassword", "string", secret),
			attr("registryPasswordSet", "bool", { readOnly: true }),
			attr("remoteHostId", "string"),
			attr("timeoutSeconds", "int", { default: 900 }),
		],
		collectionPath: "/cron-jobs",
		description:
			"A scheduled job: a container, source code on a runtime image, or a host command.",
		importId: ["id"],
		itemPath: "/cron-jobs/{id}",
		label: "name",
		type: "homerun_cron_job",
	},
	{
		attributes: [
			attr("source", "string", required),
			attr("destination", "string", required),
			attr("enabled", "bool", on),
			attr("keepPath", "bool", on),
			attr("permanent", "bool", on),
		],
		collectionPath: "/redirects",
		description: "A hostname, or a path under it, redirected to another URL.",
		importId: ["id"],
		itemPath: "/redirects/{id}",
		label: "source",
		type: "homerun_redirect",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("kind", "string", {
				...replace,
				description: "webhook, discord, slack, telegram or email.",
			}),
			attr("target", "string", {
				...required,
				...secret,
				description:
					"The webhook URL, email address, or Telegram bot_token:chat_id.",
			}),
			attr("targetLabel", "string", { readOnly: true }),
			attr("enabled", "bool", on),
			attr("events", "strings"),
			attr("groupMessages", "bool", off),
		],
		collectionPath: "/notification-channels",
		description: "Where notifications are sent.",
		importId: ["id"],
		itemPath: "/notification-channels/{id}",
		label: "name",
		type: "homerun_notification_channel",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("type", "string", {
				default: "s3",
				description: "s3, sftp, smb or webdav.",
				forceNew: true,
			}),
			attr("endpoint", "string", required),
			attr("bucket", "string"),
			attr("region", "string"),
			attr("accessKeyId", "string", required),
			attr("secretAccessKey", "string", { ...required, ...secret }),
			attr("secretAccessKeySet", "bool", { readOnly: true }),
		],
		collectionPath: "/backup-destinations",
		description: "Where volume backups are written.",
		importId: ["id"],
		itemPath: "/backup-destinations/{id}",
		label: "name",
		type: "homerun_backup_destination",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("slug", "string", required),
			attr("scope", "string", {
				...required,
				description: "global, stack or custom.",
			}),
			attr("description", "string"),
			attr("isPublic", "bool", off),
			attr("domains", "strings", {
				description: "Domains a public page also answers on.",
			}),
			attr("stackId", "string", { ref: "homerun_stack" }),
			attr("services", "objects", {
				description: "The services a custom page shows.",
				fields: [
					attr("serviceId", "string", { ...required, ref: "homerun_service" }),
					attr("includeChildren", "bool", off),
				],
			}),
		],
		collectionPath: "/status-pages",
		description: "A status page.",
		importId: ["id"],
		itemPath: "/status-pages/{id}",
		label: "slug",
		type: "homerun_status_page",
	},
	{
		adminOnly: true,
		attributes: [
			attr("name", "string", required),
			attr("provider", "string", {
				...replace,
				description: "The DNS provider's id, e.g. cloudflare.",
				tf: "dns_provider",
			}),
			attr("credentials", "stringMap", {
				...required,
				...secret,
				description: "The provider's credential fields, by key.",
			}),
			attr("setFields", "strings", { readOnly: true }),
		],
		collectionPath: "/dns-connections",
		description:
			"An account at a DNS provider Homerun manages records through.",
		importId: ["id"],
		itemPath: "/dns-connections/{id}",
		label: "name",
		type: "homerun_dns_connection",
	},
	{
		adminOnly: true,
		attributes: [
			attr("kind", "string", {
				...replace,
				description:
					"gitlab, gitea or bitbucket. GitHub Apps are registered from the dashboard, then imported.",
			}),
			attr("name", "string", required),
			attr("baseUrl", "string"),
			attr("clientId", "string", required),
			attr("clientSecret", "string", { ...required, ...secret }),
			attr("clientSecretSet", "bool", { readOnly: true }),
			attr("enabled", "bool", on),
		],
		collectionPath: "/git-providers",
		description: "A git provider users connect their account to.",
		importId: ["id"],
		itemPath: "/git-providers/{id}",
		label: "name",
		type: "homerun_git_provider",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("registryUrl", "string", required),
			attr("username", "string", required),
			attr("password", "string", { ...required, ...secret }),
			attr("passwordSet", "bool", { readOnly: true }),
		],
		collectionPath: "/build-cache-registries",
		description: "A registry git builds use as their layer cache.",
		importId: ["id"],
		itemPath: "/build-cache-registries/{id}",
		label: "name",
		type: "homerun_build_cache_registry",
	},
	{
		adminOnly: true,
		attributes: [
			attr("name", "string", required),
			attr("endpoint", "string", required),
			attr("region", "string", { default: "us-east-1" }),
			attr("accessKeyId", "string", required),
			attr("secretAccessKey", "string", { ...required, ...secret }),
			attr("kind", "string", { readOnly: true }),
		],
		collectionPath: "/object-stores",
		description: "An S3-compatible object store.",
		importId: ["id"],
		itemPath: "/object-stores/{id}",
		label: "name",
		type: "homerun_object_store",
	},
	{
		adminOnly: true,
		attributes: [
			attr("storeId", "string", { ...replace, ref: "homerun_object_store" }),
			attr("name", "string", replace),
			attr("expirationDays", "int", {
				description: "Delete objects this many days after they're written.",
			}),
			attr("public", "bool", {
				...off,
				description:
					"Serve the bucket's objects to anyone at /public/{storeId}/{bucket}/{key}, without signing in.",
			}),
		],
		collectionPath: "/object-stores/{storeId}/buckets",
		description: "A bucket on an object store.",
		importId: ["storeId", "name"],
		itemPath: "/object-stores/{storeId}/buckets/{name}",
		label: "name",
		type: "homerun_bucket",
	},
	{
		attributes: [
			attr("name", "string", required),
			attr("disabled", "bool", {
				...off,
				description: "Refuse the account's API keys without deleting it.",
			}),
			attr("permissions", "stringMap", {
				default: {},
				description: `The areas the account may use, each set to ${PERMISSION_LEVELS.join(" or ")}. Areas: ${PERMISSION_AREAS.map((area) => area.key).join(", ")}. The API cuts them down to what the provider's own API key holds.`,
			}),
		],
		collectionPath: "/service-accounts",
		description:
			"A service account: a non-human user with no sign-in method. Put its id in a service's auth_allowed_user_ids or preview_auth_allowed_user_ids to let its API keys through that login wall. Its keys are minted from the dashboard or the API, never here, so no secret lands in the state.",
		importId: ["id"],
		itemPath: "/service-accounts/{id}",
		label: "name",
		type: "homerun_service_account",
	},
	...IAC_SETTINGS_RESOURCES,
	...infrastructureResources(attr),
	...IAC_IDENTITY_RESOURCES,
];

export const IAC_DATA_SOURCES: IacDataSource[] = [
	{
		attributes: [
			attr("name", "string"),
			attr("description", "string"),
			attr("category", "string"),
			attr("image", "string"),
			attr("tag", "string"),
			attr("containerPort", "int"),
			attr("envVars", "stringMap"),
			attr("cpuLimit", "string"),
			attr("memoryLimitMb", "int"),
			attr("volumes", "strings"),
		],
		collectionPath: "/templates",
		description: "A built-in or custom template, by id or name.",
		itemPath: "/templates/{id}",
		lookup: ["name"],
		type: "homerun_template",
	},
	{
		collectionPath: "/services",
		description: "A service, by id or slug.",
		itemPath: "/services/{id}",
		lookup: ["slug"],
		resource: "homerun_service",
		type: "homerun_service",
	},
	versions.serviceVersionDataSource(attr),
	{
		collectionPath: "/stacks",
		description: "A stack, by id or slug.",
		itemPath: "/stacks/{id}",
		lookup: ["slug"],
		resource: "homerun_stack",
		type: "homerun_stack",
	},
];

/** The resource spec for a Terraform type, or undefined. */
export function iacResource(type: string): IacResource | undefined {
	return IAC_RESOURCES.find((resource) => resource.type === type);
}

/** The attributes Terraform state and the live object both carry: everything but write-only, create-only and provider-side ones. */
export function comparableAttributes(resource: IacResource): IacAttribute[] {
	return resource.attributes.filter(
		(attribute) => !(attribute.writeOnly || attribute.createOnly),
	);
}

/**
 * An API value as Terraform state holds it: nested objects keyed by their
 * snake_case attribute names, absent values as null.
 */
export function toStateValue(attribute: IacAttribute, value: unknown): unknown {
	if (value === undefined || value === null) {
		return null;
	}
	if (attribute.kind === "objects" && Array.isArray(value)) {
		return value.map((entry: Record<string, unknown>) =>
			Object.fromEntries(
				(attribute.fields ?? []).map((field) => [
					field.tf,
					toStateValue(field, entry?.[field.name]),
				]),
			),
		);
	}
	return value;
}

/** The import id of a live object: its id, or its composite id fields joined with "/". */
export function importIdOf(
	resource: IacResource,
	object: Record<string, unknown>,
): string {
	return resource.importId
		.map((field) => String(object[field] ?? ""))
		.join("/");
}

/** The whole spec as the Terraform provider embeds it (`bun run gen` writes it next to the provider). */
export function iacSpec(): {
	dataSources: IacDataSource[];
	resources: IacResource[];
} {
	return { dataSources: IAC_DATA_SOURCES, resources: IAC_RESOURCES };
}
