import type { ManifestInput } from "#lib/server/manifest.js";

export interface DetectedPort {
	port: number;
	protocol: "both" | "tcp" | "udp";
}

export interface DetectedManifest {
	errors: string[];
	keys: string[];
	path: string;
}

export interface DetectedConfig {
	command: string[] | null;
	entrypoint: string[] | null;
	env: Record<string, string>;
	healthcheck: string | null;
	manifest: DetectedManifest | null;
	ports: DetectedPort[];
	source: "dockerfile" | "image" | "manifest";
	user: string | null;
	volumes: string[];
	workdir: string | null;
}

export interface OciImageConfig {
	Cmd?: string[] | null;
	Entrypoint?: string[] | null;
	Env?: string[] | null;
	ExposedPorts?: Record<string, unknown> | null;
	Healthcheck?: { Test?: string[] | null } | null;
	User?: string | null;
	Volumes?: Record<string, unknown> | null;
	WorkingDir?: string | null;
}

type StageConfig = Omit<DetectedConfig, "manifest" | "source"> & {
	ownCommand: boolean;
	vars: Record<string, string>;
};

const SYSTEM_ENV_KEYS = new Set([
	"GPG_KEY",
	"HOME",
	"HOSTNAME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"PATH",
	"TERM",
]);
const SYSTEM_ENV_SUFFIX_RE = /_(VERSION|SHA256|SHA512|DOWNLOAD_URL|GPG_KEYS?)$/;
const ESCAPE_DIRECTIVE_RE = /^#\s*escape\s*=\s*([\\`])\s*$/i;
const HEREDOC_RE = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g;
const VAR_RE =
	/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const FLAG_RE = /^--[a-z-]+=\S*\s*/i;
const PORT_RE = /^(\d+)(?:-\d+)?(?:\/(tcp|udp|sctp))?$/i;
const WHITESPACE_RE = /\s+/;
const TOKEN_RE = /(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g;

/** A fresh, empty per-stage config. */
function emptyStage(vars: Record<string, string> = {}): StageConfig {
	return {
		command: null,
		entrypoint: null,
		env: {},
		healthcheck: null,
		ownCommand: false,
		ports: [],
		user: null,
		vars: { ...vars },
		volumes: [],
		workdir: null,
	};
}

/** A deep copy of `stage`, for a stage built `FROM` an earlier one. */
function cloneStage(stage: StageConfig): StageConfig {
	return {
		...stage,
		command: stage.command ? [...stage.command] : null,
		entrypoint: stage.entrypoint ? [...stage.entrypoint] : null,
		env: { ...stage.env },
		ownCommand: false,
		ports: stage.ports.map((p) => ({ ...p })),
		vars: { ...stage.vars },
		volumes: [...stage.volumes],
	};
}

/**
 * Expands `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR:+alt}` against
 * `vars`, the way the Dockerfile builder does; an unknown variable expands
 * to an empty string.
 */
function substitute(text: string, vars: Record<string, string>): string {
	return text.replace(VAR_RE, (...groups: (string | undefined)[]) => {
		const [, braced, op, word, bare] = groups;
		const name = braced ?? bare ?? "";
		const value = vars[name];
		if (op === ":-") {
			return value ? value : (word ?? "");
		}
		if (op === "-") {
			return value ?? word ?? "";
		}
		if (op === ":+") {
			return value ? (word ?? "") : "";
		}
		if (op === "+") {
			return value === undefined ? "" : (word ?? "");
		}
		return value ?? "";
	});
}

/** Strips one layer of matching quotes and unescapes `\"` inside double quotes. */
function unquote(token: string): string {
	if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
		return token.slice(1, -1).replace(/\\(.)/g, "$1");
	}
	if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
		return token.slice(1, -1);
	}
	return token;
}

/** Splits `text` on whitespace, keeping quoted runs together. */
function tokens(text: string): string[] {
	return text.match(TOKEN_RE) ?? [];
}

/** A JSON exec-form array (`["a", "b"]`), or null for the shell form. */
function execForm(text: string): string[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[")) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** CMD/ENTRYPOINT arguments, wrapping the shell form in `/bin/sh -c`. */
function commandArgs(text: string): string[] {
	return execForm(text) ?? ["/bin/sh", "-c", text.trim()];
}

/** `["CMD-SHELL", "x"]` or `["CMD", "a", "b"]` as one readable command line. */
function healthcheckFromTest(test: string[] | null | undefined): string | null {
	if (!test || test.length === 0) {
		return null;
	}
	const [kind, ...rest] = test;
	if (kind === "NONE") {
		return "NONE";
	}
	return rest.join(" ") || null;
}

/** Folds an exposed port into `ports`, skipping duplicates and SCTP. */
function addPort(ports: DetectedPort[], spec: string): void {
	const match = PORT_RE.exec(spec.trim());
	if (!match) {
		return;
	}
	const port = Number(match[1]);
	const protocol = (match[2]?.toLowerCase() ?? "tcp") as
		| DetectedPort["protocol"]
		| "sctp";
	if (protocol === "sctp" || port < 1 || port > 65535) {
		return;
	}
	if (!ports.some((p) => p.port === port && p.protocol === protocol)) {
		ports.push({ port, protocol });
	}
}

/** Appends `path` to `volumes` unless it's already there. */
function addVolume(volumes: string[], path: string): void {
	const clean = path.trim();
	if (clean.startsWith("/") && !volumes.includes(clean)) {
		volumes.push(clean);
	}
}

/** Joins the Dockerfile's physical lines into logical instructions. */
function logicalLines(text: string): string[] {
	const raw = text.replace(/\r\n?/g, "\n").split("\n");
	let escape = "\\";
	const directive = raw.find((line) => line.trim() !== "");
	const escapeMatch = directive
		? ESCAPE_DIRECTIVE_RE.exec(directive.trim())
		: null;
	if (escapeMatch) {
		escape = escapeMatch[1];
	}

	const lines: string[] = [];
	let current = "";
	let heredocs: string[] = [];
	for (const line of raw) {
		if (heredocs.length > 0) {
			if (line.trim() === heredocs[0]) {
				heredocs.shift();
			}
			continue;
		}
		const trimmed = line.trim();
		if (trimmed.startsWith("#") || (trimmed === "" && current !== "")) {
			continue;
		}
		const continued = trimmed.endsWith(escape);
		current += `${continued ? trimmed.slice(0, -1) : trimmed} `;
		if (continued) {
			continue;
		}
		const instruction = current.trim();
		current = "";
		if (!instruction) {
			continue;
		}
		lines.push(instruction);
		heredocs = [...instruction.matchAll(HEREDOC_RE)].map((m) => m[1]);
	}
	if (current.trim()) {
		lines.push(current.trim());
	}
	return lines;
}

/** Applies an `ENV` instruction's arguments to `stage`. */
function applyEnv(stage: StageConfig, args: string): void {
	const parts = tokens(args);
	if (parts.length > 0 && !parts[0].includes("=")) {
		const [key] = parts;
		const value = substitute(args.trim().slice(key.length).trim(), stage.vars);
		stage.env[key] = value;
		stage.vars[key] = value;
		return;
	}
	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = part.slice(0, eq);
		const value = substitute(unquote(part.slice(eq + 1)), stage.vars);
		stage.env[key] = value;
		stage.vars[key] = value;
	}
}

/** Applies an `ARG` instruction's defaults to `vars`, taking a bare name's value from `globals`. */
function applyArg(
	vars: Record<string, string>,
	args: string,
	globals: Record<string, string>,
): void {
	for (const part of tokens(args)) {
		const eq = part.indexOf("=");
		if (eq > 0) {
			vars[part.slice(0, eq)] = substitute(unquote(part.slice(eq + 1)), vars);
		} else if (globals[part] !== undefined && vars[part] === undefined) {
			vars[part] = globals[part];
		}
	}
}

/**
 * Opens the stage a `FROM` starts, inheriting from the earlier stage it
 * names, and registers it under its index and `AS` alias.
 */
function startStage(
	args: string,
	globals: Record<string, string>,
	stages: Map<string, StageConfig>,
): { alias: string | undefined; stage: StageConfig } {
	const parts = tokens(args).filter((part) => !part.startsWith("--"));
	const base = substitute(parts[0] ?? "", globals).toLowerCase();
	const alias =
		parts[1]?.toUpperCase() === "AS" ? parts[2]?.toLowerCase() : undefined;
	const parent = stages.get(base);
	const stage = parent ? cloneStage(parent) : emptyStage();
	stages.set(String(stages.size), stage);
	if (alias) {
		stages.set(alias, stage);
	}
	return { alias, stage };
}

/** Joins a relative `WORKDIR` onto the current one. */
function resolveWorkdir(current: string | null, dir: string): string {
	return dir.startsWith("/")
		? dir
		: `${(current ?? "").replace(/\/$/, "")}/${dir}`;
}

const INSTRUCTIONS: Record<
	string,
	(stage: StageConfig, args: string, globals: Record<string, string>) => void
> = {
	ARG: (stage, args, globals) => applyArg(stage.vars, args, globals),
	CMD: (stage, args) => {
		stage.command = commandArgs(args);
		stage.ownCommand = true;
	},
	ENTRYPOINT: (stage, args) => {
		stage.entrypoint = commandArgs(args);
		if (!stage.ownCommand) {
			stage.command = null;
		}
	},
	ENV: (stage, args) => applyEnv(stage, args),
	EXPOSE: (stage, args) => {
		for (const spec of tokens(substitute(args, stage.vars))) {
			addPort(stage.ports, unquote(spec));
		}
	},
	HEALTHCHECK: (stage, args) => applyHealthcheck(stage, args),
	USER: (stage, args) => {
		stage.user = substitute(args, stage.vars) || null;
	},
	VOLUME: (stage, args) => {
		const expanded = substitute(args, stage.vars);
		for (const path of execForm(expanded) ?? tokens(expanded).map(unquote)) {
			addVolume(stage.volumes, path);
		}
	},
	WORKDIR: (stage, args) => {
		stage.workdir = resolveWorkdir(
			stage.workdir,
			substitute(unquote(args), stage.vars),
		);
	},
};

/** Applies a `HEALTHCHECK` instruction, dropping its `--interval=` style flags. */
function applyHealthcheck(stage: StageConfig, args: string): void {
	let rest = args.trim();
	while (FLAG_RE.test(rest)) {
		rest = rest.replace(FLAG_RE, "");
	}
	if (rest.toUpperCase() === "NONE") {
		stage.healthcheck = "NONE";
		return;
	}
	const body = rest.replace(/^CMD\s+/i, "");
	const exec = execForm(body);
	stage.healthcheck = exec ? exec.join(" ") : body || null;
}

/** Strips a stage's private build variables from its public config. */
function finish(
	stage: StageConfig,
	source: DetectedConfig["source"],
): DetectedConfig {
	const { ownCommand: _own, vars: _vars, ...config } = stage;
	return { ...config, manifest: null, source };
}

/**
 * Reads what a Dockerfile declares about the container it builds: exposed
 * ports, volumes, env, healthcheck, user, workdir, command and entrypoint,
 * for the final stage (or `target` when given). A stage built `FROM` an
 * earlier stage inherits that stage's config; one built from an external
 * image only reports what the Dockerfile itself adds, since the base
 * image's own config isn't fetched. Never throws: garbage parses to an
 * empty config.
 */
export function parseDockerfile(text: string, target?: string): DetectedConfig {
	const globals: Record<string, string> = {};
	const stages = new Map<string, StageConfig>();
	let stage: StageConfig | null = null;
	let found: StageConfig | null = null;

	for (const line of logicalLines(text)) {
		const space = line.search(WHITESPACE_RE);
		const keyword = (space === -1 ? line : line.slice(0, space)).toUpperCase();
		const args = space === -1 ? "" : line.slice(space + 1).trim();

		if (keyword === "FROM") {
			const next = startStage(args, globals, stages);
			stage = next.stage;
			if (target && next.alias === target.toLowerCase()) {
				found = stage;
			}
		} else if (!stage) {
			if (keyword === "ARG") {
				applyArg(globals, args, globals);
			}
		} else if (found && stage !== found) {
			break;
		} else {
			INSTRUCTIONS[keyword]?.(stage, args, globals);
		}
	}

	return finish(found ?? stage ?? emptyStage(), "dockerfile");
}

/**
 * Turns an image's OCI config (a registry config blob's `config`, or a
 * daemon inspect's `Config`) into the same shape `parseDockerfile` returns.
 */
export function configFromImage(
	config: OciImageConfig | null | undefined,
): DetectedConfig {
	const stage = emptyStage();
	for (const spec of Object.keys(config?.ExposedPorts ?? {})) {
		addPort(stage.ports, spec);
	}
	for (const path of Object.keys(config?.Volumes ?? {})) {
		addVolume(stage.volumes, path);
	}
	for (const entry of config?.Env ?? []) {
		const eq = entry.indexOf("=");
		if (eq > 0) {
			stage.env[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
	}
	stage.healthcheck = healthcheckFromTest(config?.Healthcheck?.Test);
	stage.user = config?.User || null;
	stage.workdir = config?.WorkingDir || null;
	stage.command = config?.Cmd?.length ? config.Cmd : null;
	stage.entrypoint = config?.Entrypoint?.length ? config.Entrypoint : null;
	return finish(stage, "image");
}

/**
 * The detected env worth offering as editable overrides: drops the
 * plumbing every base image sets (`PATH`, `HOME`, `LANG`, a runtime's
 * `*_VERSION`/`*_SHA256` pins) that nobody means to change per service.
 */
export function overridableEnv(
	env: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!SYSTEM_ENV_KEYS.has(key) &&
				!key.startsWith("LC_") &&
				!SYSTEM_ENV_SUFFIX_RE.test(key),
		),
	);
}

/** The port to route to: the first one carrying TCP (the manifest's, when it sets one), else the first at all. */
export function primaryPort(
	config: DetectedConfig | null,
): DetectedPort | null {
	if (!config || config.ports.length === 0) {
		return null;
	}
	return config.ports.find((p) => p.protocol !== "udp") ?? config.ports[0];
}

/** Whether `config` found anything worth showing. */
export function hasDetected(
	config: DetectedConfig | null,
): config is DetectedConfig {
	return (
		!!config &&
		(!!config.manifest ||
			config.ports.length > 0 ||
			config.volumes.length > 0 ||
			Object.keys(config.env).length > 0 ||
			!!config.healthcheck ||
			!!config.user ||
			!!config.workdir ||
			!!config.command ||
			!!config.entrypoint)
	);
}

const MANIFEST_APPLIED_KEYS = new Set([
	"command",
	"containerPort",
	"entrypoint",
	"envVars",
	"healthcheckCommand",
	"healthcheckDisabled",
	"portProtocol",
	"runAsUser",
]);

/**
 * Lays a repository's Homerun Manifest over what its Dockerfile declares
 * (or over nothing, when there's no Dockerfile to read): the manifest wins
 * for the port, env, healthcheck, user, command and entrypoint it sets, the
 * way it does on every deploy. Its other keys are listed in
 * `manifest.keys` as applied on deploy; a manifest that didn't validate
 * contributes only its errors.
 */
export function withManifest(
	base: DetectedConfig | null,
	file: { errors: string[]; manifest: ManifestInput | null; path: string },
): DetectedConfig {
	const config: DetectedConfig = base
		? { ...base, env: { ...base.env }, ports: [...base.ports] }
		: { ...finish(emptyStage(), "manifest") };
	const manifest = file.manifest ?? {};
	config.manifest = {
		errors: file.errors,
		keys: Object.keys(manifest).filter(
			(key) => !MANIFEST_APPLIED_KEYS.has(key),
		),
		path: file.path,
	};
	if (manifest.containerPort) {
		const protocol = manifest.portProtocol ?? "tcp";
		config.ports = [
			{ port: manifest.containerPort, protocol },
			...config.ports.filter((p) => p.port !== manifest.containerPort),
		];
	} else if (manifest.portProtocol && config.ports.length > 0) {
		config.ports[0] = { ...config.ports[0], protocol: manifest.portProtocol };
	}
	config.env = { ...config.env, ...manifest.envVars };
	if (manifest.healthcheckDisabled) {
		config.healthcheck = "NONE";
	} else if (manifest.healthcheckCommand) {
		config.healthcheck = manifest.healthcheckCommand;
	}
	config.user = manifest.runAsUser || config.user;
	config.command = manifest.command?.length ? manifest.command : config.command;
	config.entrypoint = manifest.entrypoint?.length
		? manifest.entrypoint
		: config.entrypoint;
	return config;
}

/** Where `config` came from, for a label: "the image", "the Dockerfile", ".homerun.json and the Dockerfile". */
export function detectedFrom(config: DetectedConfig): string {
	const base =
		config.source === "manifest"
			? null
			: config.source === "dockerfile"
				? "the Dockerfile"
				: "the image";
	const manifest = config.manifest?.path.split("/").pop() ?? null;
	return [manifest, base].filter(Boolean).join(" and ");
}
