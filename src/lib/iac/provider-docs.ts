import { PROVIDER_SOURCE } from "#lib/iac/generate.js";
import {
	expression,
	type HclBlock,
	type HclValue,
	renderHcl,
} from "#lib/iac/hcl.js";
import {
	IAC_DATA_SOURCES,
	IAC_RESOURCES,
	type IacAttribute,
	type IacDataSource,
	type IacResource,
	iacResource,
	toSnakeCase,
} from "#lib/iac/resources.js";
import { SINGLETON_ID } from "#lib/iac/resources-settings.js";

const DOCS_URL =
	"https://github.com/orochibraru/homerun/blob/main/docs/infrastructure-as-code.md";

const LOCAL_NAME = "example";

/** A realistic configuration for every resource, attribute by attribute, used as its registry page's example. */
export const RESOURCE_EXAMPLES: Record<string, [string, HclValue][]> = {
	homerun_authentication_settings: [
		["email_otp", true],
		["magic_link", false],
		["require_two_factor", true],
	],
	homerun_backup_destination: [
		["name", "offsite"],
		["endpoint", "https://s3.eu-central-1.amazonaws.com"],
		["bucket", "homerun-backups"],
		["access_key_id", expression("var.backup_access_key_id")],
		["secret_access_key", expression("var.backup_secret_access_key")],
	],
	homerun_bucket: [
		["store_id", expression("homerun_object_store.example.id")],
		["name", "uploads"],
		["expiration_days", 30],
	],
	homerun_build_cache_registry: [
		["name", "build-cache"],
		["registry_url", "ghcr.io/acme/build-cache"],
		["username", "acme"],
		["password", expression("var.build_cache_token")],
	],
	homerun_cron_job: [
		["name", "nightly-report"],
		["kind", "image"],
		["schedule", "0 3 * * *"],
		["image", "alpine"],
		["command", "echo report"],
		["enabled", true],
	],
	homerun_dns_connection: [
		["name", "cloudflare"],
		["dns_provider", "cloudflare"],
		["credentials", { apiToken: expression("var.cloudflare_token") }],
	],
	homerun_dns_record: [
		["domain_id", expression("homerun_domain.example.id")],
		["name", "mail.example.com"],
		["type", "MX"],
		["content", "mx.mailprovider.com"],
		["priority", 10],
	],
	homerun_domain: [
		["name", "example.com"],
		["connection_id", expression("homerun_dns_connection.example.id")],
		["zone_id", "023e105f4ecef8ad9ca31a8372d0c353"],
		["target", "203.0.113.10"],
	],
	homerun_error_pages: [
		["brand_name", "Acme"],
		["accent_color", "#8b2942"],
		["page_texts", { notFoundTitle: "Nothing to see here" }],
	],
	homerun_git_provider: [
		["kind", "gitea"],
		["name", "gitea"],
		["base_url", "https://git.example.com"],
		["client_id", expression("var.gitea_client_id")],
		["client_secret", expression("var.gitea_client_secret")],
	],
	homerun_instance_settings: [
		["base_domain", "apps.example.com"],
		["update_channel", "stable"],
		["traefik_acme_email", "ops@example.com"],
	],
	homerun_ip_ban_settings: [
		["enabled", true],
		["threshold", 10],
		["duration_hours", 24],
	],
	homerun_notification_channel: [
		["name", "ops"],
		["kind", "discord"],
		["target", expression("var.discord_webhook_url")],
	],
	homerun_oauth_provider: [
		["name", "pocket-id"],
		["label", "Pocket ID"],
		["client_id", expression("var.pocket_id_client_id")],
		["client_secret", expression("var.pocket_id_client_secret")],
		[
			"discovery_url",
			"https://id.example.com/.well-known/openid-configuration",
		],
	],
	homerun_object_store: [
		["name", "r2"],
		["endpoint", "https://<account>.r2.cloudflarestorage.com"],
		["access_key_id", expression("var.r2_access_key_id")],
		["secret_access_key", expression("var.r2_secret_access_key")],
	],
	homerun_redirect: [
		["source", "www.example.com"],
		["destination", "https://example.com"],
	],
	homerun_registry_settings: [
		["auth_enabled", true],
		["public_host", "registry.example.com"],
	],
	homerun_registry_token: [["username", "ci"]],
	homerun_remote_host: [
		["name", "build-box"],
		["kind", "agent"],
		["agent_url", "http://10.0.0.5:7420"],
		["agent_token", expression("var.build_box_agent_token")],
	],
	homerun_service: [
		["name", "whoami"],
		["slug", "whoami"],
		["stack_id", expression("homerun_stack.example.id")],
		["image", "traefik/whoami"],
		["container_port", 80],
		["env_vars", { LOG_LEVEL: "info" }],
		["deploy_on_change", true],
	],
	homerun_service_account: [
		["name", "ci-smoke-tests"],
		["permissions", { services: "read" }],
	],
	homerun_service_dependency: [
		["service_id", expression("homerun_service.app.id")],
		["depends_on_id", expression("homerun_service.database.id")],
	],
	homerun_service_environment: [
		["service_id", expression("homerun_service.example.id")],
		["name", "staging"],
		["ref", "develop"],
		["env_overrides", { LOG_LEVEL: "debug" }],
	],
	homerun_smtp_settings: [
		["enabled", true],
		["host", "smtp.example.com"],
		["port", 587],
		["username", "homerun@example.com"],
		["password", expression("var.smtp_password")],
		["from", "Homerun <homerun@example.com>"],
	],
	homerun_stack: [
		["name", "Media"],
		["slug", "media"],
		["description", "Everything that serves the media library."],
	],
	homerun_status_page: [
		["name", "Status"],
		["slug", "status"],
		["scope", "global"],
	],
	homerun_tls_settings: [
		["certificate", expression('file("wildcard.example.com.pem")')],
		["private_key", expression("var.wildcard_private_key")],
	],
	homerun_user: [
		["email", "jane@example.com"],
		["name", "Jane"],
		["role", "custom"],
		["permissions", { services: "write", stacks: "read" }],
	],
	homerun_volume: [
		["name", "postgres-data"],
		["kind", "volume"],
		["source", "postgres-data"],
		["backup_enabled", true],
		["backup_schedule", "0 2 * * *"],
		["s3_destination_id", expression("homerun_backup_destination.example.id")],
	],
	homerun_volume_mount: [
		["service_id", expression("homerun_service.example.id")],
		["volume_id", expression("homerun_volume.example.id")],
		["container_path", "/var/lib/postgresql/data"],
	],
	homerun_workstation: [
		["name", "api"],
		["git_url", "https://github.com/acme/api.git"],
		["extensions", ["esbenp.prettier-vscode"]],
		["memory_limit_mb", 4096],
		["auto_stop_mode", "idle"],
		["auto_stop_minutes", 60],
	],
	homerun_workstation_preset: [
		["name", "node"],
		["description", "Node 22 with Prettier."],
		["image", "codercom/code-server:latest"],
		["extensions", ["esbenp.prettier-vscode"]],
	],
};

const DATA_SOURCE_EXAMPLES: Record<string, [string, HclValue][]> = {
	homerun_service: [["slug", "whoami"]],
	homerun_stack: [["slug", "media"]],
	homerun_template: [["name", "PostgreSQL"]],
};

const KIND_LABELS: Record<IacAttribute["kind"], string> = {
	bool: "Boolean",
	int: "Number",
	intMap: "Map of Number",
	objects: "List of Object",
	string: "String",
	stringMap: "Map of String",
	strings: "List of String",
};

const DEPLOY_ON_CHANGE: IacAttribute = {
	default: false,
	description:
		"Deploy after every create or change, and wait for the deploy to finish.",
	kind: "bool",
	name: "deployOnChange",
	tf: "deploy_on_change",
};

const ID: IacAttribute = {
	description: "The object's id.",
	kind: "string",
	name: "id",
	readOnly: true,
	tf: "id",
};

/** A sentence ending with a full stop, so notes appended after it read as separate sentences. */
function sentence(text: string | undefined): string {
	const trimmed = (text ?? "").trim();
	if (!trimmed) {
		return "";
	}
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One `- \`name\` (Type) description` line of a schema list, with what Terraform does about it spelled out. */
function attributeLine(attribute: IacAttribute): string {
	const type = [
		KIND_LABELS[attribute.kind],
		...(attribute.sensitive ? ["Sensitive"] : []),
	].join(", ");
	const notes = [
		sentence(attribute.description),
		attribute.kind === "objects"
			? `See the nested schema for \`${attribute.tf}\` below.`
			: "",
		attribute.forceNew ? "Changing it replaces the resource." : "",
		attribute.createOnly
			? "Sent on create only and never read back: changing it replaces the resource, unless it was imported without one."
			: "",
		attribute.writeOnly && !attribute.createOnly
			? "Write-only: the API never returns it, so Terraform can't detect a change made outside it."
			: "",
		attribute.default === undefined
			? ""
			: `Defaults to \`${JSON.stringify(attribute.default)}\`.`,
	].filter(Boolean);
	return `- \`${attribute.tf}\` (${type})${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`;
}

/** A schema list under its heading, or nothing when it's empty. */
function section(heading: string, attributes: IacAttribute[]): string[] {
	if (attributes.length === 0) {
		return [];
	}
	return [
		heading,
		"",
		...attributes
			.toSorted((first, second) => first.tf.localeCompare(second.tf))
			.map(attributeLine),
		"",
	];
}

/** The nested schema sections of every list-of-objects attribute. */
function nestedSections(attributes: IacAttribute[]): string[] {
	return attributes
		.filter((attribute) => attribute.kind === "objects")
		.flatMap((attribute) => {
			const fields = attribute.fields ?? [];
			return [
				`### Nested schema for \`${attribute.tf}\``,
				"",
				...section(
					"Required:",
					fields.filter((field) => field.required),
				),
				...section(
					"Optional:",
					fields.filter((field) => !field.required),
				),
			];
		});
}

/** The front matter and title every registry page opens with. */
function header(title: string, description: string): string[] {
	return [
		"---",
		`page_title: ${JSON.stringify(title)}`,
		`description: ${JSON.stringify(sentence(description))}`,
		"---",
		"",
		`# ${title}`,
		"",
		sentence(description),
		"",
	];
}

/** A fenced Terraform code block. */
function terraform(blocks: HclBlock[]): string[] {
	return ["```terraform", renderHcl(blocks).trimEnd(), "```", ""];
}

/** The registry page of one resource: an example, its schema and how to import it. */
function resourcePage(resource: IacResource): string {
	const attributes = resource.deployable
		? [...resource.attributes, DEPLOY_ON_CHANGE]
		: resource.attributes;
	const importId = resource.singleton
		? SINGLETON_ID
		: resource.importId.map((field) => `<${toSnakeCase(field)}>`).join("/");
	const importLead = resource.singleton
		? `There's only one, so its import id is always \`${SINGLETON_ID}\`. Import it with an \`import\` block:`
		: `Import an existing object by its ${resource.importId.length > 1 ? `\`${importId}\`` : "id"}, with an \`import\` block:`;
	return [
		...header(`${resource.type} (Resource)`, resource.description),
		"## Example usage",
		"",
		...terraform([
			{
				attributes: RESOURCE_EXAMPLES[resource.type] ?? [],
				labels: [resource.type, LOCAL_NAME],
				type: "resource",
			},
		]),
		"## Schema",
		"",
		...section(
			"### Required",
			attributes.filter(
				(attribute) => attribute.required && !attribute.readOnly,
			),
		),
		...section(
			"### Optional",
			attributes.filter(
				(attribute) => !(attribute.required || attribute.readOnly),
			),
		),
		...section("### Read-only", [
			ID,
			...attributes.filter((attribute) => attribute.readOnly),
		]),
		...nestedSections(attributes),
		"## Import",
		"",
		importLead,
		"",
		...terraform([
			{
				attributes: [
					["to", expression(`${resource.type}.${LOCAL_NAME}`)],
					["id", importId],
				],
				labels: [],
				type: "import",
			},
		]),
		"or the command line:",
		"",
		"```shell",
		`terraform import ${resource.type}.${LOCAL_NAME} "${importId}"`,
		"```",
		"",
	].join("\n");
}

/** The attributes a data source returns: its own list, or the resource's that the API reads back. */
function dataSourceAttributes(dataSource: IacDataSource): IacAttribute[] {
	const attributes = dataSource.resource
		? (iacResource(dataSource.resource)?.attributes ?? [])
		: (dataSource.attributes ?? []);
	return attributes.filter(
		(attribute) => !(attribute.writeOnly || attribute.createOnly),
	);
}

/** The registry page of one data source: an example, the attributes it looks up by and what it returns. */
function dataSourcePage(dataSource: IacDataSource): string {
	const attributes = dataSourceAttributes(dataSource);
	const lookups = attributes.filter((attribute) =>
		dataSource.lookup.includes(attribute.name),
	);
	const lookupIds: IacAttribute = {
		...ID,
		description: `The object's id. Set it, or ${lookups.map((attribute) => `\`${attribute.tf}\``).join(" or ")}, to pick the object.`,
		readOnly: false,
	};
	return [
		...header(`${dataSource.type} (Data Source)`, dataSource.description),
		"## Example usage",
		"",
		...terraform([
			{
				attributes: DATA_SOURCE_EXAMPLES[dataSource.type] ?? [],
				labels: [dataSource.type, LOCAL_NAME],
				type: "data",
			},
		]),
		"## Schema",
		"",
		...section("### Optional", [lookupIds, ...lookups]),
		...section(
			"### Read-only",
			attributes
				.filter((attribute) => !dataSource.lookup.includes(attribute.name))
				.map((attribute) => ({ ...attribute, default: undefined })),
		),
		...nestedSections(attributes),
	].join("\n");
}

/** The provider's landing page: what it manages, how to configure and authenticate it. */
function indexPage(): string {
	return [
		...header(
			"Homerun Provider",
			"Manages a Homerun instance: stacks, services and every setting the dashboard has",
		),
		`It talks to the instance's REST API with an API key, so every resource needs the key to hold the matching permission (write on Services for \`homerun_service\`, on DNS for \`homerun_dns_connection\`, and so on). The provider is released with every Homerun version, and the instance's **Infrastructure as Code** page generates a ready-to-plan project, with an import block for everything that already runs. See [the Homerun documentation](${DOCS_URL}) for the full guide.`,
		"",
		"## Example usage",
		"",
		...terraform([
			{
				attributes: [],
				blocks: [
					{
						attributes: [["homerun", { source: PROVIDER_SOURCE }]],
						labels: [],
						type: "required_providers",
					},
				],
				labels: [],
				type: "terraform",
			},
			{
				attributes: [["endpoint", "https://homerun.example.com"]],
				labels: ["homerun"],
				type: "provider",
			},
			{
				attributes: RESOURCE_EXAMPLES.homerun_stack ?? [],
				labels: ["homerun_stack", LOCAL_NAME],
				type: "resource",
			},
		]),
		"Set the API key in `HOMERUN_API_KEY` rather than in the configuration. Create one under **Profile → API Keys**, with an expiry and only the permissions the configuration needs.",
		"",
		"## Schema",
		"",
		...section("### Optional", [
			{
				description:
					"An API key (Profile → API Keys). Defaults to the `HOMERUN_API_KEY` environment variable.",
				kind: "string",
				name: "apiKey",
				sensitive: true,
				tf: "api_key",
			},
			{
				description:
					"The instance's URL, for example `https://homerun.example.com`. Defaults to the `HOMERUN_ENDPOINT` environment variable.",
				kind: "string",
				name: "endpoint",
				tf: "endpoint",
			},
		]),
	].join("\n");
}

/**
 * The provider's Terraform Registry documentation, by path under the
 * provider's `docs/` folder: the landing page, one page per resource and
 * one per data source, from the same spec the provider is built from.
 */
export function providerDocs(): Record<string, string> {
	const short = (type: string) => type.replace(/^homerun_/, "");
	return {
		"index.md": indexPage(),
		...Object.fromEntries(
			IAC_RESOURCES.map((resource) => [
				`resources/${short(resource.type)}.md`,
				resourcePage(resource),
			]),
		),
		...Object.fromEntries(
			IAC_DATA_SOURCES.map((dataSource) => [
				`data-sources/${short(dataSource.type)}.md`,
				dataSourcePage(dataSource),
			]),
		),
	};
}
