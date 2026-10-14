import type { Inventory, LiveObject } from "#lib/iac/generate.js";
import {
	comparableAttributes,
	IAC_RESOURCES,
	type IacResource,
	iacResource,
	importIdOf,
	toStateValue,
} from "#lib/iac/resources.js";

export interface StateInstance {
	address: string;
	attributes: Record<string, unknown>;
	type: string;
}

export interface AttributeDrift {
	attribute: string;
	live: unknown;
	/** A sensitive attribute's values are left out: only that it changed is reported. */
	sensitive: boolean;
	state: unknown;
}

export interface DriftedResource {
	address: string;
	changes: AttributeDrift[];
	id: string;
	type: string;
}

export interface MissingResource {
	address: string;
	id: string;
	type: string;
}

export interface UnmanagedObject {
	id: string;
	label: string;
	type: string;
}

export interface DriftReport {
	drifted: DriftedResource[];
	inSync: number;
	missing: MissingResource[];
	unmanaged: UnmanagedObject[];
}

interface RawResource {
	instances?: { attributes?: Record<string, unknown>; index_key?: unknown }[];
	mode?: string;
	module?: string;
	name?: string;
	type?: string;
}

/**
 * Every managed `homerun_*` resource instance a Terraform state holds, with
 * its address and attributes.
 *
 * @throws When the body isn't a JSON object.
 */
export function homerunInstances(body: string): StateInstance[] {
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("The state isn't a JSON object.");
	}
	const resources = (parsed as { resources?: RawResource[] }).resources ?? [];
	return resources
		.filter(
			(resource) =>
				resource.mode !== "data" && resource.type?.startsWith("homerun_"),
		)
		.flatMap((resource) =>
			(resource.instances ?? []).map((instance) => {
				const module = resource.module ? `${resource.module}.` : "";
				const index =
					instance.index_key === undefined
						? ""
						: `[${JSON.stringify(instance.index_key)}]`;
				return {
					address: `${module}${resource.type}.${resource.name}${index}`,
					attributes: instance.attributes ?? {},
					type: resource.type ?? "",
				};
			}),
		);
}

function stable(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, inner]) => inner !== null && inner !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** The import id a state instance's attributes point at, through the spec's composite id fields. */
function stateImportId(
	resource: IacResource,
	attributes: Record<string, unknown>,
) {
	const byName: LiveObject = { id: attributes.id };
	for (const attribute of resource.attributes) {
		byName[attribute.name] = attributes[attribute.tf];
	}
	return importIdOf(resource, byName);
}

/** What differs between a state instance's attributes and the live object, attribute by attribute. */
export function attributeDrift(
	resource: IacResource,
	state: Record<string, unknown>,
	live: LiveObject,
): AttributeDrift[] {
	const changes: AttributeDrift[] = [];
	for (const attribute of comparableAttributes(resource)) {
		if (attribute.readOnly || !(attribute.tf in state)) {
			continue;
		}
		const stateValue = state[attribute.tf] ?? null;
		const liveValue = toStateValue(attribute, live[attribute.name]);
		if (stable(stateValue) !== stable(liveValue)) {
			const sensitive = attribute.sensitive === true;
			changes.push({
				attribute: attribute.tf,
				live: sensitive ? null : liveValue,
				sensitive,
				state: sensitive ? null : stateValue,
			});
		}
	}
	return changes;
}

/** A drift value as the page shows it: strings as is, null as `null`, anything else as JSON. */
export function formatDriftValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

function label(resource: IacResource, object: LiveObject): string {
	const value = object[resource.label];
	return typeof value === "string" && value
		? value
		: importIdOf(resource, object);
}

/**
 * Compares a Terraform state with what's running: the `homerun_*`
 * resources whose attributes changed outside Terraform (drifted), the ones
 * whose object is gone (missing), and the live objects no resource in the
 * state manages (unmanaged). Write-only attributes (secrets) can't be
 * compared and are left out, and a singleton (instance settings) is never
 * unmanaged: it always exists, whether a state manages it or not.
 */
export function detectDrift(body: string, inventory: Inventory): DriftReport {
	const report: DriftReport = {
		drifted: [],
		inSync: 0,
		missing: [],
		unmanaged: [],
	};
	const managed = new Map<string, Set<string>>();
	for (const instance of homerunInstances(body)) {
		const resource = iacResource(instance.type);
		if (!resource) {
			continue;
		}
		const id = stateImportId(resource, instance.attributes);
		managed.set(
			resource.type,
			(managed.get(resource.type) ?? new Set()).add(id),
		);
		const live = (inventory[resource.type] ?? []).find(
			(object) => importIdOf(resource, object) === id,
		);
		if (!live) {
			report.missing.push({
				address: instance.address,
				id,
				type: resource.type,
			});
			continue;
		}
		const changes = attributeDrift(resource, instance.attributes, live);
		if (changes.length > 0) {
			report.drifted.push({
				address: instance.address,
				changes,
				id,
				type: resource.type,
			});
		} else {
			report.inSync++;
		}
	}
	for (const resource of IAC_RESOURCES.filter((entry) => !entry.singleton)) {
		for (const object of inventory[resource.type] ?? []) {
			const id = importIdOf(resource, object);
			if (!managed.get(resource.type)?.has(id)) {
				report.unmanaged.push({
					id,
					label: label(resource, object),
					type: resource.type,
				});
			}
		}
	}
	return report;
}
