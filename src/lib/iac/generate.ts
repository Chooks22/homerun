import { SECRET_MASK } from "#lib/formatting.js";
import {
	expression,
	type HclBlock,
	type HclValue,
	quote,
	renderHcl,
} from "#lib/iac/hcl.js";
import {
	IAC_RESOURCES,
	type IacAttribute,
	type IacResource,
	importIdOf,
	toStateValue,
} from "#lib/iac/resources.js";

export type LiveObject = Record<string, unknown>;

/** Every live object Homerun manages, by Terraform resource type, as the REST API returns it. */
export type Inventory = Record<string, LiveObject[]>;

export const PROVIDER_SOURCE = "orochibraru/homerun";

/** What one generated project covers: a stack with its substacks, or one service. */
export interface GenerateScope {
	id: string;
	kind: "service" | "stack";
}

/** A stack or a service a project can cover, as a picker shows it. */
export interface IacScopeOption {
	group: "Services" | "Stacks";
	label: string;
	name: string;
	value: string;
}

/** A scope from its `stack:<id>` or `service:<id>` form, null for anything else. */
export function parseScope(value: string | null): GenerateScope | null {
	const match = value?.match(/^(stack|service):([\w-]+)$/);
	return match
		? { id: match[2], kind: match[1] as GenerateScope["kind"] }
		: null;
}

export interface GenerateOptions {
	/** The Terraform state project's API base, `<origin>/api/v1/iac/projects/<id>`, or null for no backend block. */
	backendAddress: string | null;
	/** The command the README tells to run, `terraform` when unset (`tofu` for OpenTofu). */
	cli?: string;
	/** The instance's URL the provider talks to. */
	endpoint: string;
	generatedAt: Date;
	/** What the project covers, a stack's or a service's name, for its README. */
	name: string;
}

const RESERVED_NAMES = new Set(["count", "for_each", "provider", "lifecycle"]);

/** A Terraform name (letters, digits, underscores) from free text. */
export function terraformName(text: string): string {
	const name = text
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!name) {
		return "unnamed";
	}
	return /^[0-9]/.test(name) || RESERVED_NAMES.has(name) ? `r_${name}` : name;
}

function stringField(object: LiveObject, field: string): string {
	const value = object[field];
	return typeof value === "string" ? value : "";
}

/** The ids of a stack and every stack nested under it, at any depth. */
function stackFamily(stacks: LiveObject[], rootId: string): Set<string> {
	const family = new Set([rootId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const stack of stacks) {
			const id = stringField(stack, "id");
			if (!family.has(id) && family.has(stringField(stack, "parentId"))) {
				family.add(id);
				grew = true;
			}
		}
	}
	return family;
}

/**
 * The part of an inventory one stack covers: the stack and its substacks,
 * their services with those services' environments, dependencies, mounts
 * and mounted volumes, and the status pages of those stacks.
 */
export function scopeToStack(inventory: Inventory, stackId: string): Inventory {
	const stacks = stackFamily(inventory.homerun_stack ?? [], stackId);
	const pick = (type: string, keep: (object: LiveObject) => boolean) =>
		(inventory[type] ?? []).filter(keep);
	const services = pick("homerun_service", (svc) =>
		stacks.has(stringField(svc, "stackId")),
	);
	const serviceIds = new Set(services.map((svc) => stringField(svc, "id")));
	const ofService = (object: LiveObject) =>
		serviceIds.has(stringField(object, "serviceId"));
	const mounts = pick("homerun_volume_mount", ofService);
	const volumeIds = new Set(
		mounts.map((mount) => stringField(mount, "volumeId")),
	);
	return {
		homerun_service: services,
		homerun_service_dependency: pick("homerun_service_dependency", ofService),
		homerun_service_environment: pick("homerun_service_environment", ofService),
		homerun_stack: pick("homerun_stack", (stack) =>
			stacks.has(stringField(stack, "id")),
		),
		homerun_status_page: pick("homerun_status_page", (page) =>
			stacks.has(stringField(page, "stackId")),
		),
		homerun_volume: pick("homerun_volume", (volume) =>
			volumeIds.has(stringField(volume, "id")),
		),
		homerun_volume_mount: mounts,
	};
}

/**
 * The part of an inventory one service covers: the service, its
 * environments, the dependencies it declares, and its mounts with the
 * volumes they mount. Its stack and the services it depends on stay
 * outside, referenced by id.
 */
export function scopeToService(
	inventory: Inventory,
	serviceId: string,
): Inventory {
	const ofService = (object: LiveObject) =>
		stringField(object, "serviceId") === serviceId;
	const pick = (type: string, keep: (object: LiveObject) => boolean) =>
		(inventory[type] ?? []).filter(keep);
	const mounts = pick("homerun_volume_mount", ofService);
	const volumeIds = new Set(
		mounts.map((mount) => stringField(mount, "volumeId")),
	);
	return {
		homerun_service: pick(
			"homerun_service",
			(svc) => stringField(svc, "id") === serviceId,
		),
		homerun_service_dependency: pick("homerun_service_dependency", ofService),
		homerun_service_environment: pick("homerun_service_environment", ofService),
		homerun_volume: pick("homerun_volume", (volume) =>
			volumeIds.has(stringField(volume, "id")),
		),
		homerun_volume_mount: mounts,
	};
}

/** Each object's local name in the configuration, unique per type, by type then id. */
export function localNames(
	inventory: Inventory,
): Map<string, Map<string, string>> {
	const names = new Map<string, Map<string, string>>();
	const nameOf = (type: string, id: string) => names.get(type)?.get(id) ?? "";
	for (const resource of IAC_RESOURCES) {
		const taken = new Set<string>();
		const byId = new Map<string, string>();
		for (const object of inventory[resource.type] ?? []) {
			let base = terraformName(stringField(object, resource.label));
			if (resource.type === "homerun_service_dependency") {
				base = `${nameOf("homerun_service", stringField(object, "serviceId"))}_on_${nameOf("homerun_service", stringField(object, "dependsOnId"))}`;
			} else if (resource.type === "homerun_volume_mount") {
				base = `${nameOf("homerun_service", stringField(object, "serviceId"))}_${nameOf("homerun_volume", stringField(object, "volumeId"))}`;
			}
			let name = base;
			for (let suffix = 2; taken.has(name); suffix++) {
				name = `${base}_${suffix}`;
			}
			taken.add(name);
			byId.set(importIdOf(resource, object), name);
		}
		names.set(resource.type, byId);
	}
	return names;
}

function isEmpty(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		(Array.isArray(value) && value.length === 0) ||
		(typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value as object).length === 0)
	);
}

interface SecretVariable {
	description: string;
	name: string;
	type: "map(string)" | "string";
	/** What it's set to today, null for a secret Homerun never reads back. */
	value: string | null;
}

interface RenderContext {
	names: Map<string, Map<string, string>>;
	variables: SecretVariable[];
}

function variable(context: RenderContext, input: SecretVariable) {
	context.variables.push(input);
	return expression(`var.${input.name}`);
}

/**
 * A tfvars file: each secret's value, or for one Homerun can't read back
 * (or `mask`ed ones, for showing on a page) a placeholder. A placeholder is
 * commented out when the value is unknown, so Terraform asks for it rather
 * than applying an empty secret over the real one.
 */
function tfvars(
	variables: SecretVariable[],
	mode: "example" | "masked" | "values",
): string {
	const empty = (variable: SecretVariable) =>
		variable.type === "map(string)" ? "{}" : '""';
	return `${variables
		.map((variable) => {
			if (mode === "example") {
				return `${variable.name} = ${empty(variable)}`;
			}
			if (variable.value === null) {
				return `# ${variable.name} = ${empty(variable)} # Homerun never returns it: fill it in`;
			}
			return `${variable.name} = ${quote(mode === "masked" ? SECRET_MASK : variable.value)}`;
		})
		.join("\n")}\n`;
}

function envVarsValue(
	object: LiveObject,
	localName: string,
	context: RenderContext,
): HclValue {
	const secretKeys = new Set(
		Array.isArray(object.secretEnvKeys) ? object.secretEnvKeys : [],
	);
	const vars = (object.envVars ?? {}) as Record<string, string>;
	return Object.fromEntries(
		Object.entries(vars).map(([envKey, value]) => [
			envKey,
			secretKeys.has(envKey)
				? variable(context, {
						description: `${envKey} of ${localName}`,
						name: `${localName}_${terraformName(envKey)}`,
						type: "string",
						value,
					})
				: value,
		]),
	);
}

function attributeValue(
	attribute: IacAttribute,
	object: LiveObject,
	localName: string,
	context: RenderContext,
): HclValue | undefined {
	if (attribute.readOnly || attribute.createOnly) {
		return;
	}
	if (attribute.writeOnly) {
		return attribute.required
			? variable(context, {
					description: `${attribute.tf} of ${localName}`,
					name: `${localName}_${attribute.tf}`,
					type: attribute.kind === "stringMap" ? "map(string)" : "string",
					value: null,
				})
			: undefined;
	}
	const value = object[attribute.name];
	if (attribute.ref && typeof value === "string" && value) {
		const target = context.names.get(attribute.ref)?.get(value);
		return target ? expression(`${attribute.ref}.${target}.id`) : value;
	}
	if (
		!attribute.required &&
		(isEmpty(value) ||
			JSON.stringify(value) === JSON.stringify(attribute.default))
	) {
		return;
	}
	if (attribute.name === "envVars" && "secretEnvKeys" in object) {
		return envVarsValue(object, localName, context);
	}
	return toStateValue(attribute, value) as HclValue;
}

function resourceBlock(
	resource: IacResource,
	object: LiveObject,
	localName: string,
	context: RenderContext,
): HclBlock {
	const attributes: [string, HclValue][] = [];
	for (const attribute of resource.attributes) {
		const value = attributeValue(attribute, object, localName, context);
		if (value !== undefined) {
			attributes.push([attribute.tf, value]);
		}
	}
	return { attributes, labels: [resource.type, localName], type: "resource" };
}

function terraformBlock(options: GenerateOptions): HclBlock {
	const base = options.backendAddress;
	return {
		attributes: [],
		blocks: [
			{
				attributes: [["homerun", { source: PROVIDER_SOURCE }]],
				labels: [],
				type: "required_providers",
			},
			...(base
				? [
						{
							attributes: [
								["address", `${base}/state`],
								["lock_address", `${base}/lock`],
								["unlock_address", `${base}/lock`],
								["lock_method", "POST"],
								["unlock_method", "DELETE"],
								["username", "homerun"],
							] as [string, HclValue][],
							labels: ["http"],
							type: "backend",
						},
					]
				: []),
		],
		labels: [],
		type: "terraform",
	};
}

export interface GeneratedFile {
	content: string;
	path: string;
	/** What a page may show instead of `content`, when `content` carries secrets. */
	preview?: string;
}

const SERVICE_OWNED = new Set([
	"homerun_service_dependency",
	"homerun_service_environment",
	"homerun_volume_mount",
]);

/** Which file of the structure an object's blocks go in: one per service with what hangs off it, stacks and volumes together. */
function fileOf(
	resource: IacResource,
	object: LiveObject,
	names: Map<string, Map<string, string>>,
): string {
	const serviceName = (id: string) =>
		names.get("homerun_service")?.get(id) ?? null;
	if (resource.type === "homerun_service") {
		return `service_${serviceName(stringField(object, "id")) ?? "unnamed"}.tf`;
	}
	if (SERVICE_OWNED.has(resource.type)) {
		const owner = serviceName(stringField(object, "serviceId"));
		return owner ? `service_${owner}.tf` : "services.tf";
	}
	if (resource.type === "homerun_status_page") {
		return "stacks.tf";
	}
	return `${resource.type.replace(/^homerun_/, "").replace(/y$/, "ie")}s.tf`;
}

function readme(
	options: GenerateOptions,
	hasVariables: boolean,
	hasBackend: boolean,
): string {
	const cli = options.cli ?? "terraform";
	const steps = [
		`Export a Homerun API key: \`export HOMERUN_API_KEY=<key>\`${hasBackend ? " (and the same key as `TF_HTTP_PASSWORD`, for the state backend)" : ""}.`,
		...(hasVariables
			? [
					"`terraform.tfvars` holds the secrets: env vars marked secret come filled in with what runs today, and the commented-out lines are secrets Homerun never reads back, to fill in. Keep it out of git (the `.gitignore` does); `terraform.tfvars.example` is the shareable, empty copy.",
				]
			: []),
		`Run \`${cli} init\`, then \`${cli} plan\`: the \`import\` blocks adopt what already runs, so the plan only imports.`,
		`Run \`${cli} apply\`. From then on, change the configuration and apply instead of clicking.`,
	];
	return [
		`# ${options.name}`,
		"",
		`Terraform configuration for ${options.name} on Homerun (${options.endpoint}), generated on ${options.generatedAt.toISOString().slice(0, 10)}.`,
		"",
		...steps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"Each service has its own file, with its environments, dependencies and volume mounts next to it.",
		"",
	].join("\n");
}

/**
 * A ready-to-use Terraform project for what's running: the provider (and the
 * state backend), then for every object a resource block plus an `import`
 * block, so `terraform plan` adopts them instead of creating new ones,
 * spread over one file per service, `stacks.tf` and `volumes.tf`. Values the
 * API never returns (passwords, keys) and env vars marked secret become
 * sensitive variables, set in `terraform.tfvars` (with the env vars' current
 * values, and a masked `preview` for a page) and listed empty in
 * `terraform.tfvars.example`.
 * Files and the objects in them come in a fixed order, so two runs on the
 * same instance match.
 */
export function generateStructure(
	inventory: Inventory,
	options: GenerateOptions,
): GeneratedFile[] {
	const context: RenderContext = {
		names: localNames(inventory),
		variables: [],
	};
	const byFile = new Map<string, HclBlock[]>();
	for (const resource of IAC_RESOURCES) {
		const objects = [...(inventory[resource.type] ?? [])]
			.map((object) => ({
				name:
					context.names.get(resource.type)?.get(importIdOf(resource, object)) ??
					"",
				object,
			}))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const { name, object } of objects) {
			const path = fileOf(resource, object, context.names);
			byFile.set(path, [
				...(byFile.get(path) ?? []),
				resourceBlock(resource, object, name, context),
				{
					attributes: [
						["to", expression(`${resource.type}.${name}`)],
						["id", importIdOf(resource, object)],
					],
					labels: [],
					type: "import",
				},
			]);
		}
	}
	const hasVariables = context.variables.length > 0;
	const files: GeneratedFile[] = [
		{
			content: readme(options, hasVariables, Boolean(options.backendAddress)),
			path: "README.md",
		},
		{ content: renderHcl([terraformBlock(options)]), path: "versions.tf" },
		{
			content: renderHcl([
				{
					attributes: [["endpoint", options.endpoint]],
					labels: ["homerun"],
					type: "provider",
				},
			]),
			path: "providers.tf",
		},
		...[...byFile.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, blocks]) => ({ content: renderHcl(blocks), path })),
	];
	if (hasVariables) {
		files.push(
			{
				content: renderHcl(
					context.variables.map((secret) => ({
						attributes: [
							["description", secret.description],
							["sensitive", true],
							["type", expression(secret.type)],
						],
						labels: [secret.name],
						type: "variable",
					})),
				),
				path: "variables.tf",
			},
			{
				content: tfvars(context.variables, "values"),
				path: "terraform.tfvars",
				preview: tfvars(context.variables, "masked"),
			},
			{
				content: tfvars(context.variables, "example"),
				path: "terraform.tfvars.example",
			},
		);
	}
	files.push({
		content:
			".terraform/\n*.tfstate\n*.tfstate.*\nterraform.tfvars\ncrash.log\n",
		path: ".gitignore",
	});
	return files;
}

/** How many objects of each type an inventory holds, for the page's summary, singletons (instance settings) left out. */
export function inventoryCounts(
	inventory: Inventory,
): { count: number; type: string }[] {
	return IAC_RESOURCES.filter((resource) => !resource.singleton)
		.map((resource) => ({
			count: inventory[resource.type]?.length ?? 0,
			type: resource.type,
		}))
		.filter((entry) => entry.count > 0);
}
