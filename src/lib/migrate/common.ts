import {
	type ComposeFileDraft,
	ComposeParseError,
	type ComposeRegistryDraft,
	type ComposeServiceDraft,
	type ComposeVolumeDraft,
	parseComposeFile,
	slugifyComposeKey,
} from "#lib/compose-import.js";
import { parseDotEnv } from "#lib/env-parse.js";
import { splitImageRef } from "#lib/image-ref.js";

export type MigrationEntryKind = "application" | "compose" | "database";

export interface MigrationConnection {
	baseUrl: string;
	token: string;
}

export interface MigrationEntry {
	blocked: string | null;
	drafts: ComposeServiceDraft[];
	id: string;
	kind: MigrationEntryKind;
	name: string;
	projectName: string;
	summary: string;
	warnings: string[];
}

export interface MigrationPreviewService {
	envCount: number;
	name: string;
	port: number;
	public: boolean;
	slug: string;
	slugTaken: boolean;
	volumeCount: number;
}

export interface MigrationPreviewEntry {
	blocked: string | null;
	id: string;
	kind: MigrationEntryKind;
	name: string;
	projectName: string;
	services: MigrationPreviewService[];
	summary: string;
	warnings: string[];
}

export interface MigrationPreview {
	entries: MigrationPreviewEntry[];
	projects: string[];
}

export interface MigrationImportResult {
	imported: Array<{ name: string; services: number }>;
	skipped: Array<{ name: string; reason: string }>;
}

export type MigrationFormState =
	| {
			error?: string;
			preview?: MigrationPreview;
			result?: MigrationImportResult;
			values?: { baseUrl: string };
	  }
	| null
	| undefined;

export type RawRow = Record<string, unknown>;

const DEFAULT_PORT = 80;

/** Whether a value from a source platform's API is a plain object row. */
export function isRow(value: unknown): value is RawRow {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces an untrusted API value to its object rows, dropping anything else;
 * non-arrays become an empty list.
 */
export function rows(value: unknown): RawRow[] {
	return Array.isArray(value) ? value.filter(isRow) : [];
}

/**
 * Reads the first of the given keys that holds a non-blank string (trimmed) or a
 * finite number (stringified), for API rows whose field names vary by version.
 */
export function str(row: RawRow, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			return String(value);
		}
	}
	return null;
}

/**
 * Reads the first of the given keys that holds a finite number or a numeric
 * string.
 */
export function num(row: RawRow, ...keys: string[]): number | null {
	for (const key of keys) {
		const value = row[key];
		const parsed =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

/**
 * Extracts the list from an API response that may be a bare array, a `{ data }`
 * envelope, or a tRPC-style `{ result: { data } }` envelope.
 *
 * @returns null when the body matches none of those shapes.
 */
export function listFrom(body: unknown): unknown[] | null {
	if (Array.isArray(body)) {
		return body;
	}
	if (isRow(body)) {
		if (Array.isArray(body.data)) {
			return body.data;
		}
		const result = body.result;
		if (isRow(result) && Array.isArray(result.data)) {
			return result.data;
		}
	}
	return null;
}

/**
 * Parses a dotenv-style text blob as stored by the source platform into a
 * key/value map; anything that isn't a non-blank string yields an empty map.
 */
export function parseEnvBlob(raw: unknown): Record<string, string> {
	if (typeof raw !== "string" || !raw.trim()) {
		return {};
	}
	return Object.fromEntries(
		parseDotEnv(raw).map(({ key, value }) => [key, value]),
	);
}

/**
 * Substitutes `${VAR}`, `${VAR-default}` and `${VAR:-default}` references in a
 * compose file from the given env. A variable that is empty or missing falls back
 * to its default, or is left untouched when there is none.
 */
export function interpolate(text: string, env: Record<string, string>): string {
	return text.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g,
		(match, key: string, fallback: string | undefined) => {
			if (env[key] !== undefined && env[key] !== "") {
				return env[key];
			}
			return fallback ?? match;
		},
	);
}

/**
 * Strips leading `./` or `/` and trailing slashes from a repo-relative path,
 * returning null when nothing meaningful is left.
 */
export function trimPath(path: string | null): string | null {
	const cleaned = (path ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
	return cleaned && cleaned !== "." ? cleaned : null;
}

/**
 * Joins repo-relative path segments with `/`, skipping empty ones, or null when
 * every segment is empty.
 */
export function joinPaths(...parts: Array<string | null>): string | null {
	return trimPath(
		parts
			.map(trimPath)
			.filter((part): part is string => !!part)
			.join("/"),
	);
}

/**
 * Slugifies a source resource name for use as a Homerun service slug, falling
 * back to `service` when nothing survives slugification.
 */
export function sourceSlug(name: string): string {
	return slugifyComposeKey(name) || "service";
}

export interface SingleDraftInput {
	build?: ComposeServiceDraft["build"];
	capAdd?: string[];
	command?: string[] | null;
	containerPort: number | null;
	cpuLimit?: string | null;
	devices?: string[];
	domains?: string[];
	stripPathDomains?: string[];
	entrypoint?: string[] | null;
	envVars: Record<string, string>;
	files?: ComposeFileDraft[];
	image: string | null;
	labels?: Record<string, string>;
	memoryLimitMb?: number | null;
	name: string;
	privileged?: boolean;
	public: boolean;
	registry?: ComposeRegistryDraft | null;
	runAsUser?: string | null;
	volumes?: ComposeVolumeDraft[];
}

/**
 * Builds a compose-import service draft for a single-container source resource
 * (an application or database), with the default port, bridge networking and an
 * `unless-stopped` restart policy. Without an image it falls back to
 * `<slug>:latest`, which suits git-built services.
 */
export function singleDraft(input: SingleDraftInput): ComposeServiceDraft {
	const slug = sourceSlug(input.name);
	const ref = input.image
		? splitImageRef(input.image)
		: { image: slug, tag: "latest" };
	return {
		build: input.build ?? null,
		capAdd: input.capAdd ?? [],
		command: input.command ?? null,
		containerPort: input.containerPort ?? DEFAULT_PORT,
		cpuLimit: input.cpuLimit ?? null,
		dependsOn: [],
		devices: input.devices ?? [],
		dnsResolvable: input.public,
		domains: input.domains ?? [],
		entrypoint: input.entrypoint ?? null,
		envFiles: [],
		envVars: input.envVars,
		files: input.files ?? [],
		image: ref.image,
		key: slug,
		labels: input.labels ?? {},
		memoryLimitMb: input.memoryLimitMb ?? null,
		missingEnvFiles: [],
		name: input.name,
		networkMode: "bridge",
		portProtocol: "tcp",
		privileged: input.privileged ?? false,
		publishedPorts: [],
		registry: input.registry ?? null,
		restartPolicy: "unless-stopped",
		runAsUser: input.runAsUser ?? null,
		slug,
		stripPathDomains: input.stripPathDomains ?? [],
		tag: ref.tag,
		volumes: input.volumes ?? [],
		warnings: [],
	};
}

/**
 * Parses a source compose file into service drafts after interpolating the
 * resource's env into it, resolving `env_file:` references against the given
 * file contents, collecting the parse warnings (prefixed per service) and a
 * warning when variables are still unresolved.
 *
 * @returns `error` set, and no drafts, when the file can't be parsed.
 */
export function composeDrafts(
	file: string,
	env: Record<string, string>,
	envFiles: Record<string, string> = {},
): { drafts: ComposeServiceDraft[]; error: string | null; warnings: string[] } {
	try {
		const plan = parseComposeFile(interpolate(file, env), { envFiles });
		const unresolved = plan.services.some((svc) =>
			Object.values(svc.envVars).some((value) => /\$\{[^}]+\}/.test(value)),
		);
		return {
			drafts: plan.services,
			error: null,
			warnings: [
				...(unresolved
					? [
							"Some variables still reference values the source didn't return : fill those in by hand.",
						]
					: []),
				...plan.warnings,
				...plan.services.flatMap((svc) =>
					svc.warnings.map((warning) => `${svc.key}: ${warning}`),
				),
			],
		};
	} catch (err) {
		return {
			drafts: [],
			error:
				err instanceof ComposeParseError
					? `The compose file couldn't be read : ${err.message}`
					: String(err),
			warnings: [],
		};
	}
}

/**
 * One-line description of where a draft's image comes from: the git repo and ref
 * for a build, `image:tag` otherwise.
 */
export function imageSummary(draft: ComposeServiceDraft): string {
	if (draft.build) {
		const ref = draft.build.gitRef ? `@${draft.build.gitRef}` : "";
		const method =
			draft.build.method && draft.build.method !== "dockerfile"
				? ` · ${draft.build.method}`
				: "";
		return `git ${draft.build.gitUrl ?? "repository"}${ref}${method}`;
	}
	return `${draft.image}:${draft.tag}`;
}

/**
 * Shapes migration entries into the preview the migrate form renders, flagging
 * drafts whose slug is already used by an existing service and listing the
 * distinct project names.
 */
export function previewEntries(
	entries: MigrationEntry[],
	takenSlugs: Set<string>,
): MigrationPreview {
	return {
		entries: entries.map((entry) => ({
			blocked: entry.blocked,
			id: entry.id,
			kind: entry.kind,
			name: entry.name,
			projectName: entry.projectName,
			services: entry.drafts.map((draft) => ({
				envCount: Object.keys(draft.envVars).length,
				name: draft.name,
				port: draft.containerPort,
				public: draft.dnsResolvable,
				slug: draft.slug,
				slugTaken: takenSlugs.has(draft.slug),
				volumeCount: draft.volumes.length + draft.files.length,
			})),
			summary: entry.summary,
			warnings: entry.warnings,
		})),
		projects: [...new Set(entries.map((entry) => entry.projectName))],
	};
}

/**
 * Maps items through an async function with at most `limit` calls in flight,
 * preserving input order in the results. Rejects on the first failure.
 */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		if (next >= items.length) {
			return;
		}
		const index = next;
		next += 1;
		out[index] = await run(items[index]);
		return worker();
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

export interface HttpClientOptions {
	headers: Record<string, string>;
	label: string;
}

const TIMEOUT_MS = 20_000;

export class MigrationHttpClient {
	readonly #baseUrl: string;
	readonly #options: HttpClientOptions;

	constructor(baseUrl: string, options: HttpClientOptions) {
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
		this.#options = options;
	}

	/**
	 * Fetches and JSON-parses a path on the source platform's API with a 20s timeout
	 * and the client's auth headers.
	 *
	 * @throws With a user-facing message when the host is unreachable, rejects the
	 * token (401/403), answers with another non-2xx status, or returns non-JSON.
	 */
	async get(path: string): Promise<unknown> {
		const url = `${this.#baseUrl}${path}`;
		const res = await fetch(url, {
			headers: { accept: "application/json", ...this.#options.headers },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		}).catch((err: unknown) => {
			throw new Error(
				`Couldn't reach ${this.#options.label} at ${this.#baseUrl} : ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		if (res.status === 401 || res.status === 403) {
			throw new Error(`${this.#options.label} rejected that API token.`);
		}
		if (!res.ok) {
			throw new Error(
				`${this.#options.label} answered ${res.status} for ${path.split("?")[0]}.`,
			);
		}
		const text = await res.text();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error(
				`${this.#options.label}'s answer to ${path.split("?")[0]} wasn't JSON : check the URL points at the ${this.#options.label} dashboard itself.`,
			);
		}
	}
}
