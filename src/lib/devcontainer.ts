import { parseDotEnv } from "#lib/env-parse.js";
import { EXTENSION_ID_RE } from "#lib/workstations.js";

export const DEVCONTAINER_PATHS = [
	".devcontainer/devcontainer.json",
	".devcontainer.json",
] as const;

const UNSUPPORTED_KEYS = [
	"build",
	"dockerComposeFile",
	"features",
	"image",
	"initializeCommand",
	"mounts",
	"onCreateCommand",
	"postAttachCommand",
	"postCreateCommand",
	"postStartCommand",
	"runArgs",
	"updateContentCommand",
] as const;

/** What a workstation takes from a repository's dev container config. */
export interface DevcontainerConfig {
	env: Record<string, string>;
	extensions: string[];
	image: string | null;
	name: string | null;
	path: string;
	settings: Record<string, unknown>;
	unsupported: string[];
}

/**
 * Strips `//` and `/* *\/` comments and trailing commas from JSONC, leaving
 * string contents (URLs included) untouched.
 */
export function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') {
				end += text[end] === "\\" ? 2 : 1;
			}
			out += text.slice(i, end + 1);
			i = end + 1;
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") {
				i++;
			}
		} else if (char === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += char;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The string values of `value` that don't reference another variable (`${localEnv:X}` and the like). */
function plainEnv(value: unknown): Record<string, string> {
	if (!isObject(value)) {
		return {};
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && !entry.includes("${")) {
			env[key] = entry;
		}
	}
	return env;
}

/**
 * Reads a `devcontainer.json` found at `path` into what a workstation can
 * apply: the VS Code extensions and settings (under `customizations.vscode`
 * or the legacy top-level keys) and `containerEnv` plus `remoteEnv`. The
 * container itself (`image`, `build`, features, lifecycle commands) can't be
 * applied, since a workstation runs a web IDE image, so those keys are only
 * listed in `unsupported`.
 *
 * @returns The config, or null when the text isn't a JSON object.
 */
export function parseDevcontainer(
	text: string,
	path: string,
): DevcontainerConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonc(text));
	} catch {
		return null;
	}
	if (!isObject(parsed)) {
		return null;
	}
	const customizations = isObject(parsed.customizations)
		? parsed.customizations
		: {};
	const vscode = isObject(customizations.vscode) ? customizations.vscode : {};
	const rawExtensions = [
		...(Array.isArray(vscode.extensions) ? vscode.extensions : []),
		...(Array.isArray(parsed.extensions) ? parsed.extensions : []),
	];
	const extensions = [
		...new Set(
			rawExtensions
				.filter(
					(id): id is string =>
						typeof id === "string" && EXTENSION_ID_RE.test(id),
				)
				.map((id) => id.toLowerCase()),
		),
	];
	return {
		env: { ...plainEnv(parsed.containerEnv), ...plainEnv(parsed.remoteEnv) },
		extensions,
		image: typeof parsed.image === "string" ? parsed.image : null,
		name: typeof parsed.name === "string" ? parsed.name : null,
		path,
		settings: {
			...(isObject(parsed.settings) ? parsed.settings : {}),
			...(isObject(vscode.settings) ? vscode.settings : {}),
		},
		unsupported: UNSUPPORTED_KEYS.filter((key) => key in parsed),
	};
}

/** The `owner/repo` path of an http(s) clone URL, without `.git`; null when it has none. */
export function repoPathOf(gitUrl: string): string | null {
	try {
		const path = new URL(gitUrl).pathname
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/, "");
		return path.includes("/") ? path : null;
	} catch {
		return null;
	}
}

/** The editor and env settings a dev container config is merged into. */
export interface DevcontainerTarget {
	editorSettings: Record<string, unknown>;
	env: Record<string, string>;
	extensions: string[];
}

/**
 * Merges a dev container config into a workstation's editor and env settings:
 * its extensions are added, its settings and env win over the same keys, and
 * everything else is kept.
 */
export function applyDevcontainer(
	target: DevcontainerTarget,
	config: DevcontainerConfig,
): DevcontainerTarget {
	return {
		editorSettings: { ...target.editorSettings, ...config.settings },
		env: { ...target.env, ...config.env },
		extensions: [...new Set([...target.extensions, ...config.extensions])],
	};
}

/** Whether a dev container config has anything a workstation can apply. */
export function hasApplicable(config: DevcontainerConfig): boolean {
	return (
		config.extensions.length > 0 ||
		Object.keys(config.settings).length > 0 ||
		Object.keys(config.env).length > 0
	);
}

/** The Editor and Container section fields a dev container config is applied over. */
export interface DevcontainerFormValues extends DevcontainerTarget {
	cpuLimit: number | null;
	homePath: string;
	image: string;
	memoryLimitMb: number | null;
	port: number;
}

/** `text` parsed as a JSON object, `{}` when it isn't one. */
function objectOf(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Applies `config` over the Editor and Container fields as `data` holds them
 * (the forms' current values, typed but maybe unsaved), so nothing typed
 * there is lost. A blank image, home path or port keeps `fallback`'s; every
 * other key of `fallback` is kept as is.
 */
export function mergeDevcontainerForm<T extends DevcontainerFormValues>(
	data: FormData,
	fallback: T,
	config: DevcontainerConfig,
): T {
	const text = (key: string) => String(data.get(key) ?? "").trim();
	const number = (key: string) => (text(key) ? Number(text(key)) : null);
	const env: Record<string, string> = {};
	for (const row of parseDotEnv(String(data.get("env") ?? ""))) {
		if (row.key) {
			env[row.key] = row.value;
		}
	}
	return {
		...fallback,
		...applyDevcontainer(
			{
				editorSettings: objectOf(String(data.get("editorSettings") ?? "")),
				env,
				extensions: data.getAll("extensions").map(String),
			},
			config,
		),
		cpuLimit: number("cpuLimit"),
		homePath: text("homePath") || fallback.homePath,
		image: text("image") || fallback.image,
		memoryLimitMb: number("memoryLimitMb"),
		port: number("port") ?? fallback.port,
	};
}

/** Writes Editor and Container section `values` into `formData` the way those sections' own fields post them. */
export function appendDevcontainerForm(
	formData: FormData,
	values: DevcontainerFormValues,
): void {
	for (const extension of values.extensions) {
		formData.append("extensions", extension);
	}
	formData.set(
		"editorSettings",
		Object.keys(values.editorSettings).length > 0
			? JSON.stringify(values.editorSettings, null, 2)
			: "",
	);
	formData.set(
		"env",
		Object.entries(values.env)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
	);
	formData.set("image", values.image);
	formData.set("homePath", values.homePath);
	formData.set("port", String(values.port));
	formData.set(
		"cpuLimit",
		values.cpuLimit === null ? "" : String(values.cpuLimit),
	);
	formData.set(
		"memoryLimitMb",
		values.memoryLimitMb === null ? "" : String(values.memoryLimitMb),
	);
}
