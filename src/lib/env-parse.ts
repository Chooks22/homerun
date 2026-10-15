/**
 * Pure parsing for pasted `.env`-file content, used by every env-var form
 * (service Environment Variables section, services/new, templates/new) to turn a pasted block
 * of text into rows for the existing key/value editor. No Docker/DB
 * dependency, stays a plain exported function per the "pure transform
 * doesn't need an instance" convention.
 */
export interface ParsedEnvVar {
	key: string;
	value: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strips one layer of matching single/double quotes, if present. */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Parses `.env`-style text (`KEY=value` per line, optional `export ` prefix,
 * optional quotes, `#`-comments, blank lines all skipped). Lines that don't
 * look like `KEY=value` (no `=`, or a key that isn't a valid env var name)
 * are silently skipped rather than throwing, since pasted text may include
 * stray comments or malformed lines.
 */
export function parseDotEnv(text: string): ParsedEnvVar[] {
	const rows: ParsedEnvVar[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length).trim()
			: line;

		const eq = withoutExport.indexOf("=");
		if (eq === -1) {
			continue;
		}

		const key = withoutExport.slice(0, eq).trim();
		if (!KEY_PATTERN.test(key)) {
			continue;
		}

		const rawValue = withoutExport.slice(eq + 1).trim();
		rows.push({ key, value: unquote(rawValue) });
	}
	return rows;
}

/**
 * Merges parsed `.env` rows into an existing key/value row list: an imported
 * key overwrites the existing row with that key (in place, preserving its
 * position), a new key is appended. A single leftover blank row (the
 * "always at least one row" placeholder every env-var form seeds itself
 * with) is dropped once real rows exist.
 */
export function mergeEnvRows<T extends ParsedEnvVar>(
	existing: T[],
	imported: ParsedEnvVar[],
	makeRow: (row: ParsedEnvVar) => T,
): T[] {
	const rows = existing.filter((row) => row.key !== "" || row.value !== "");
	for (const imp of imported) {
		const target = rows.find((row) => row.key === imp.key);
		if (target) {
			target.value = imp.value;
		} else {
			rows.push(makeRow(imp));
		}
	}
	return rows.length > 0 ? rows : [makeRow({ key: "", value: "" })];
}

/**
 * A row of the dashboard's env editor. `keep` is the name a secret var was
 * stored under while the user hasn't typed a new value: the row then posts
 * no value and the server keeps the stored one, so the page never shows a
 * secret, nor how long it is. `build` marks it a build-time variable, handed
 * to a git build as a build arg too.
 */
export interface EnvEditorRow extends ParsedEnvVar {
	build: boolean;
	keep: string | null;
	secret: boolean;
}

/** A plain (not secret) env editor row, blank unless given a key and value. */
export function plainEnvRow(
	row: ParsedEnvVar = { key: "", value: "" },
): EnvEditorRow {
	return { ...row, build: false, keep: null, secret: false };
}

/**
 * The rows an env editor starts from: a var marked secret starts with no
 * value, keeping its stored one until the user types a new one, every other
 * var as stored, each flagged build-time when its name is in `buildKeys`,
 * and one blank row when there are none.
 */
export function envEditorRows(
	envVars: Record<string, string>,
	secretKeys: readonly string[],
	buildKeys: readonly string[] = [],
): EnvEditorRow[] {
	const secret = new Set(secretKeys);
	const build = new Set(buildKeys);
	const rows = Object.entries(envVars).map(([key, value]) => ({
		...(secret.has(key)
			? { keep: key, key, secret: true, value: "" }
			: plainEnvRow({ key, value })),
		build: build.has(key),
	}));
	return rows.length > 0 ? rows : [plainEnvRow()];
}

/**
 * Flips a row's secret flag. Unmarking a stored secret the user hasn't
 * retyped shows its stored value from `envVars` again, since it's no longer
 * hidden.
 */
export function toggleEnvRowSecret(
	row: EnvEditorRow,
	envVars: Record<string, string>,
): void {
	if (row.secret && row.keep !== null) {
		row.value = envVars[row.keep] ?? "";
		row.keep = null;
	}
	row.secret = !row.secret;
}

/** What a row posts as `envKeep`: the stored name it keeps the value of while it has no new value, empty otherwise. */
export function envRowKeep(row: EnvEditorRow): string {
	return row.value === "" ? (row.keep ?? "") : "";
}
