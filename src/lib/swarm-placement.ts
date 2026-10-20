export const SWARM_NODE_ROLES = ["manager", "worker"] as const;

export type SwarmNodeRole = (typeof SWARM_NODE_ROLES)[number];

export interface SwarmPlacement {
	constraints: string[];
	preferences: string[];
	roles: SwarmNodeRole[];
}

export interface SwarmPlacementSpec {
	Constraints?: string[];
	Preferences?: { Spread: { SpreadDescriptor: string } }[];
}

export const DEFAULT_SWARM_PLACEMENT: SwarmPlacement = {
	constraints: [],
	preferences: [],
	roles: ["manager", "worker"],
};

export const NODE_LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONSTRAINT_RE =
	/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|!=)\s*(\S(?:.*\S)?)$/;
const LABELS_PREFIX = "node.labels.";
const SPREAD_PREFIX = "spread=";

/** Splits a textarea's value into its non-empty, trimmed lines. */
export function placementLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Reads one `key==value` or `key!=value` constraint, tolerating a pasted
 * `node.labels.` prefix, into its canonical spacing-free form. Null when it
 * isn't one.
 */
export function normalizePlacementConstraint(raw: string): string | null {
	const match = CONSTRAINT_RE.exec(stripPrefix(raw.trim(), LABELS_PREFIX));
	if (!match) {
		return null;
	}
	const [, key, operator, value] = match;
	return `${key}${operator}${value}`;
}

/**
 * Reads one spread preference's node label key, tolerating a pasted
 * `spread=node.labels.` prefix. Null when it isn't a label key.
 */
export function normalizePlacementPreference(raw: string): string | null {
	const key = stripPrefix(
		stripPrefix(raw.trim(), SPREAD_PREFIX),
		LABELS_PREFIX,
	);
	return NODE_LABEL_KEY_RE.test(key) ? key : null;
}

/**
 * Reads a stored placement, filling what an older or partial value lacks with
 * the default (every role, no constraint, no preference).
 */
export function swarmPlacementFrom(
	value: Partial<SwarmPlacement> | null | undefined,
): SwarmPlacement {
	const roles = (value?.roles ?? []).filter((role) =>
		SWARM_NODE_ROLES.includes(role),
	);
	return {
		constraints: value?.constraints ?? [],
		preferences: value?.preferences ?? [],
		roles: roles.length > 0 ? roles : [...DEFAULT_SWARM_PLACEMENT.roles],
	};
}

/**
 * Maps a service's placement onto the swarm task template's `Placement`:
 * one role becomes `node.role==<role>`, each constraint a `node.labels.`
 * constraint, each preference a `spread=node.labels.<key>`. Undefined when
 * nothing restricts placement, so swarm schedules anywhere.
 */
export function swarmPlacementSpec(
	placement: SwarmPlacement | null | undefined,
): SwarmPlacementSpec | undefined {
	const { constraints, preferences, roles } = swarmPlacementFrom(placement);
	const all = [
		...(roles.length === 1 ? [`node.role==${roles[0]}`] : []),
		...constraints.flatMap((raw) => {
			const constraint = normalizePlacementConstraint(raw);
			return constraint ? [`${LABELS_PREFIX}${constraint}`] : [];
		}),
	];
	const spreads = preferences.flatMap((raw) => {
		const key = normalizePlacementPreference(raw);
		return key
			? [{ Spread: { SpreadDescriptor: `${LABELS_PREFIX}${key}` } }]
			: [];
	});
	if (all.length === 0 && spreads.length === 0) {
		return undefined;
	}
	return {
		Constraints: all.length > 0 ? all : undefined,
		Preferences: spreads.length > 0 ? spreads : undefined,
	};
}

/** Whether a placement is the default, scheduling on any node. */
export function isDefaultSwarmPlacement(
	placement: SwarmPlacement | null | undefined,
): boolean {
	return swarmPlacementSpec(placement) === undefined;
}

/**
 * Parses a node's labels from `key=value` lines.
 *
 * @throws When a line has no `=` or its key isn't a valid label key.
 */
export function parseNodeLabels(text: string): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const line of placementLines(text)) {
		const separator = line.indexOf("=");
		const key = (separator === -1 ? line : line.slice(0, separator)).trim();
		if (separator === -1 || !NODE_LABEL_KEY_RE.test(key)) {
			throw new Error(`"${line}" isn't a key=value label.`);
		}
		labels[key] = line.slice(separator + 1).trim();
	}
	return labels;
}

/** Formats a node's labels as the `key=value` lines `parseNodeLabels` reads. */
export function formatNodeLabels(labels: Record<string, string>): string {
	return Object.entries(labels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

function stripPrefix(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
