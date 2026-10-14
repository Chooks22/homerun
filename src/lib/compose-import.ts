import { parse as parseYaml } from "yaml";
import type { BuildMethod } from "#lib/build-methods.js";
import { parseDotEnv } from "#lib/env-parse.js";
import { splitImageRef } from "#lib/image-ref.js";
import type { PublishedPort } from "#lib/published-ports.js";
import { isRunAsUser } from "#lib/service-runtime.js";
import { argvFrom } from "#lib/shell-words.js";

export type ComposeRestartPolicy =
	| "no"
	| "always"
	| "on-failure"
	| "unless-stopped";

export interface ComposeVolumeDraft {
	containerPath: string;
	kind: "bind" | "volume";
	name: string;
	readOnly: boolean;
	source: string;
}

export interface ComposeBuildDraft {
	context: string | null;
	dockerfile: string | null;
	gitRef: string | null;
	gitUrl: string | null;
	method?: BuildMethod;
}

export interface ComposeRegistryDraft {
	password: string | null;
	url: string | null;
	username: string;
}

export interface ComposeFileDraft {
	containerPath: string;
	content: string;
}

export interface ComposeServiceDraft {
	build: ComposeBuildDraft | null;
	capAdd: string[];
	command: string[] | null;
	containerPort: number;
	cpuLimit: string | null;
	dependsOn: string[];
	devices: string[];
	dnsResolvable: boolean;
	domains: string[];
	entrypoint: string[] | null;
	envFiles: string[];
	envVars: Record<string, string>;
	files: ComposeFileDraft[];
	image: string;
	key: string;
	labels: Record<string, string>;
	memoryLimitMb: number | null;
	missingEnvFiles: string[];
	name: string;
	networkMode: "bridge" | "host";
	portProtocol: "tcp" | "udp" | "both";
	publishedPorts: PublishedPort[];
	privileged: boolean;
	registry: ComposeRegistryDraft | null;
	restartPolicy: ComposeRestartPolicy;
	runAsUser: string | null;
	slug: string;
	stripPathDomains: string[];
	tag: string;
	volumes: ComposeVolumeDraft[];
	warnings: string[];
}

export interface ComposeImportPlan {
	missingEnvFiles: string[];
	networkNames: string[];
	services: ComposeServiceDraft[];
	volumeNames: string[];
	warnings: string[];
}

export interface ComposeParseOptions {
	envFiles?: Record<string, string>;
}

export class ComposeParseError extends Error {}

const DEFAULT_CONTAINER_PORT = 80;

const UNSUPPORTED_KEYS: Record<string, string> = {
	cap_drop: "dropped capabilities are not applied",
	extra_hosts: "extra_hosts entries are not applied",
	healthcheck: "healthchecks are not applied",
	secrets: "secrets are not applied",
	sysctls: "sysctls are not applied",
	tmpfs: "tmpfs mounts are not applied",
};

const GIT_CONTEXT_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;

/**
 * Compose's own git-context syntax : `<url>[#<ref>[:<subdir>]]`, the one
 * form of `build.context` that names something this app can actually clone.
 * A plain relative path (`./api`) has no repository behind it, so it comes
 * back as a context with a null `gitUrl` and the service is created in git
 * mode waiting for one.
 */
export function parseBuildContext(context: string): ComposeBuildDraft {
	if (!GIT_CONTEXT_RE.test(context)) {
		return { context, dockerfile: null, gitRef: null, gitUrl: null };
	}
	const [url, fragment] = context.split("#");
	if (!fragment) {
		return { context: null, dockerfile: null, gitRef: null, gitUrl: url };
	}
	const [ref, subdir] = fragment.split(":");
	return {
		context: subdir || null,
		dockerfile: null,
		gitRef: ref || null,
		gitUrl: url,
	};
}

/** The `build:` section, in either of compose's two shapes : a bare context string, or an object with `context`/`dockerfile`. */
export function parseBuild(raw: unknown): ComposeBuildDraft | null {
	if (typeof raw === "string") {
		return parseBuildContext(raw);
	}
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const context =
		typeof obj.context === "string" ? parseBuildContext(obj.context) : null;
	const dockerfile = typeof obj.dockerfile === "string" ? obj.dockerfile : null;
	return {
		context: context?.context ?? null,
		dockerfile,
		gitRef: context?.gitRef ?? null,
		gitUrl: context?.gitUrl ?? null,
	};
}

/**
 * Turns a compose service key or container name into a DNS-safe service slug:
 * lowercase, dash-separated, trimmed of edge dashes and capped at 63 characters.
 */
export function slugifyComposeKey(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 63);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a compose `environment:` block in either list (`KEY=value`) or map form;
 * null map values become empty strings and list entries without `=` are dropped.
 */
function parseEnvironment(raw: unknown): Record<string, string> {
	const env: Record<string, string> = {};
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			const line = String(entry);
			const eq = line.indexOf("=");
			if (eq > 0) {
				env[line.slice(0, eq).trim()] = line.slice(eq + 1);
			}
		}
		return env;
	}
	if (isRecord(raw)) {
		for (const [key, value] of Object.entries(raw)) {
			env[key] = value === null || value === undefined ? "" : String(value);
		}
	}
	return env;
}

/** Normalizes a compose-relative path for matching, dropping a leading `./`. */
function normalizeEnvFilePath(path: string): string {
	return path.trim().replace(/^\.\//, "");
}

/** The `env_file:` entries of a service in any of compose's shapes (a string, a list of strings, or a list of `{ path, required }`), with whether each is required. */
function envFileEntries(
	raw: unknown,
): Array<{ path: string; required: boolean }> {
	const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	return list.flatMap((entry) => {
		if (typeof entry === "string" && entry.trim()) {
			return [{ path: entry.trim(), required: true }];
		}
		if (
			isRecord(entry) &&
			typeof entry.path === "string" &&
			entry.path.trim()
		) {
			return [{ path: entry.path.trim(), required: entry.required !== false }];
		}
		return [];
	});
}

interface EnvFileResolution {
	envFiles: string[];
	envVars: Record<string, string>;
	missing: string[];
}

/**
 * Resolves a service's `env_file:` entries: a file whose content was supplied
 * is parsed into variables, an absolute path that wasn't is kept for the
 * deploy to read from the host, and a relative one that wasn't is reported
 * as missing (unless compose marked it optional).
 */
export function resolveEnvFiles(
	raw: unknown,
	supplied: Record<string, string>,
	warnings: string[],
): EnvFileResolution {
	const byPath = new Map(
		Object.entries(supplied).map(([path, content]) => [
			normalizeEnvFilePath(path),
			content,
		]),
	);
	const result: EnvFileResolution = { envFiles: [], envVars: {}, missing: [] };
	for (const entry of envFileEntries(raw)) {
		const content = byPath.get(normalizeEnvFilePath(entry.path));
		if (content !== undefined) {
			for (const { key, value } of parseDotEnv(content)) {
				result.envVars[key] = value;
			}
			continue;
		}
		if (entry.path.startsWith("/")) {
			result.envFiles.push(entry.path);
			warnings.push(
				`env_file ${entry.path} is read from this host at every deploy : make sure it exists here.`,
			);
			continue;
		}
		if (entry.required) {
			result.missing.push(entry.path);
			warnings.push(
				`env_file ${entry.path} wasn't provided : paste its contents before importing, or its variables are left out.`,
			);
		}
	}
	return result;
}

const RESERVED_LABEL_RE = /^(traefik|homerun)\./;

/**
 * Reads compose `labels:` in map or `KEY=VALUE` list form. Traefik and
 * Homerun labels are dropped with a warning, since Homerun writes its own
 * routing labels and a copied router from another setup would clash with
 * them.
 */
export function parseLabels(
	raw: unknown,
	warnings: string[],
): Record<string, string> {
	const labels = parseEnvironment(raw);
	const dropped = Object.keys(labels).filter((key) =>
		RESERVED_LABEL_RE.test(key),
	);
	for (const key of dropped) {
		delete labels[key];
	}
	if (dropped.length > 0) {
		warnings.push(
			`${dropped.length} Traefik/Homerun label(s) dropped : Homerun routes the service itself.`,
		);
	}
	return labels;
}

/** Reads compose `devices:` entries, short `host:container[:perms]` strings or the long `{ source, target, permissions }` form, into Docker's short form. */
export function parseDevices(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((entry) => {
		if (typeof entry === "string" && entry.trim()) {
			return [entry.trim()];
		}
		if (isRecord(entry) && typeof entry.source === "string") {
			const target =
				typeof entry.target === "string" ? entry.target : entry.source;
			const permissions =
				typeof entry.permissions === "string" ? `:${entry.permissions}` : "";
			return [`${entry.source}:${target}${permissions}`];
		}
		return [];
	});
}

/** Reads a compose list of strings (`cap_add:`), dropping anything that isn't a non-blank string. */
function stringList(raw: unknown): string[] {
	return Array.isArray(raw)
		? raw
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
}

interface PortMapping {
	hostPort: number | null;
	port: number;
	protocol: "tcp" | "udp";
}

/**
 * Extracts the container-side port, protocol and (when the entry publishes
 * one) host port from one `ports:`/`expose:` entry in any compose shape
 * (number, `[ip:]host:container/proto` string, range, or long form object). A
 * range yields its first container port and no host port.
 */
function parsePortEntry(raw: unknown): PortMapping | null {
	if (typeof raw === "number") {
		return { hostPort: null, port: raw, protocol: "tcp" };
	}
	if (isRecord(raw)) {
		const target = Number(raw.target);
		const published = Number(raw.published);
		if (Number.isInteger(target) && target > 0) {
			return {
				hostPort:
					Number.isInteger(published) && published > 0 ? published : null,
				port: target,
				protocol: raw.protocol === "udp" ? "udp" : "tcp",
			};
		}
		return null;
	}
	if (typeof raw !== "string") {
		return null;
	}

	const [spec, rawProtocol] = raw.split("/");
	const protocol = rawProtocol === "udp" ? "udp" : "tcp";
	const parts = (spec ?? "").split(":");
	const containerSide = parts[parts.length - 1] ?? "";
	const hostSide = parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
	const port = Number(containerSide.split("-")[0]);
	const hostPort = /^\d+$/.test(hostSide) ? Number(hostSide) : null;
	return Number.isInteger(port) && port > 0
		? { hostPort: hostPort && hostPort > 0 ? hostPort : null, port, protocol }
		: null;
}

/**
 * The host mappings worth publishing: every one except the main TCP port,
 * which Traefik routes by domain instead, de-duplicated on host port and
 * protocol.
 */
function publishedPortsFor(
	mappings: PortMapping[],
	containerPort: number,
): PublishedPort[] {
	const ports: PublishedPort[] = [];
	for (const m of mappings) {
		if (
			m.hostPort === null ||
			(m.port === containerPort && m.protocol === "tcp") ||
			ports.some((p) => p.hostPort === m.hostPort && p.protocol === m.protocol)
		) {
			continue;
		}
		ports.push({
			containerPort: m.port,
			hostPort: m.hostPort,
			protocol: m.protocol,
		});
	}
	return ports;
}

function protocolFor(mappings: PortMapping[]): "tcp" | "udp" | "both" {
	const hasTcp = mappings.some((m) => m.protocol === "tcp");
	const hasUdp = mappings.some((m) => m.protocol === "udp");
	if (hasTcp && hasUdp) {
		return "both";
	}
	return hasUdp ? "udp" : "tcp";
}

/**
 * Converts a compose memory limit (bytes as a number, or a string like `512m` or
 * `1.5g`) to whole megabytes, or null when unparseable or under 1 MB.
 */
function parseMemoryLimit(raw: unknown): number | null {
	if (typeof raw === "number") {
		return Math.round(raw / (1024 * 1024)) || null;
	}
	if (typeof raw !== "string") {
		return null;
	}
	const match = /^(\d+(?:\.\d+)?)\s*([kmgb]?b?)$/i.exec(raw.trim());
	if (!match) {
		return null;
	}
	const amount = Number(match[1]);
	const unit = (match[2] ?? "").toLowerCase();
	const bytes = unit.startsWith("g")
		? amount * 1024 * 1024 * 1024
		: unit.startsWith("m")
			? amount * 1024 * 1024
			: unit.startsWith("k")
				? amount * 1024
				: amount;
	const mb = Math.round(bytes / (1024 * 1024));
	return mb > 0 ? mb : null;
}

function parseRestart(raw: unknown): ComposeRestartPolicy {
	const value = typeof raw === "string" ? raw.split(":")[0] : "";
	switch (value) {
		case "always":
			return "always";
		case "no":
			return "no";
		case "on-failure":
			return "on-failure";
		case "unless-stopped":
			return "unless-stopped";
		default:
			return "unless-stopped";
	}
}

/** Reads compose's `user:` (a name or uid, optionally `:group`), warning about and dropping one Homerun can't take. */
function parseUser(raw: unknown, warnings: string[]): string | null {
	if (typeof raw !== "string" && typeof raw !== "number") {
		return null;
	}
	const value = String(raw).trim();
	if (!value) {
		return null;
	}
	if (!isRunAsUser(value)) {
		warnings.push(
			`Skipped the user "${value}": use uid, uid:gid, name or name:group.`,
		);
		return null;
	}
	return value;
}

function parseDependsOn(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map(String);
	}
	if (isRecord(raw)) {
		return Object.keys(raw);
	}
	return [];
}

/**
 * Names the Docker volume backing a bind mount, from the service slug and the
 * container mount path, capped at 63 characters.
 */
export function bindVolumeName(
	serviceSlug: string,
	containerPath: string,
): string {
	const suffix = slugifyComposeKey(containerPath.replace(/^\//, "")) || "data";
	return `${serviceSlug}-${suffix}`.slice(0, 63);
}

/**
 * Converts a long-form compose volume object into a volume draft, pushing a
 * warning and returning null for mount types other than bind and volume or
 * entries missing a source or target.
 */
function parseLongVolume(
	raw: Record<string, unknown>,
	serviceSlug: string,
	warnings: string[],
): ComposeVolumeDraft | null {
	const type = String(raw.type ?? "volume");
	const source = raw.source === undefined ? "" : String(raw.source);
	const target = raw.target === undefined ? "" : String(raw.target);
	if (!(source && target) || (type !== "bind" && type !== "volume")) {
		warnings.push(`Skipped an unsupported "${type}" mount.`);
		return null;
	}
	return {
		containerPath: target,
		kind: type,
		name: type === "volume" ? source : bindVolumeName(serviceSlug, target),
		readOnly: raw.read_only === true,
		source,
	};
}

/**
 * Converts a `source:target[:mode]` compose volume string into a volume draft.
 * Anonymous volumes and relative bind mounts are skipped with a warning; an
 * absolute or `~` path is a bind, anything else a named volume.
 */
function parseShortVolume(
	raw: string,
	serviceSlug: string,
	warnings: string[],
): ComposeVolumeDraft | null {
	const [source, containerPath, mode] = raw.split(":");
	if (!(source && containerPath)) {
		warnings.push(
			`Skipped the anonymous volume "${raw}" : give it a name or a host path.`,
		);
		return null;
	}

	const isPath = source.startsWith("/") || source.startsWith("~");
	if (!(isPath || /^[A-Za-z0-9][\w.-]*$/.test(source))) {
		warnings.push(
			`Skipped the relative bind mount "${source}" : Homerun needs an absolute host path.`,
		);
		return null;
	}

	return {
		containerPath,
		kind: isPath ? "bind" : "volume",
		name: isPath ? bindVolumeName(serviceSlug, containerPath) : source,
		readOnly: mode === "ro",
		source,
	};
}

function parseVolumeEntry(
	raw: unknown,
	serviceSlug: string,
	warnings: string[],
): ComposeVolumeDraft | null {
	if (isRecord(raw)) {
		return parseLongVolume(raw, serviceSlug, warnings);
	}
	if (typeof raw !== "string") {
		return null;
	}
	return parseShortVolume(raw, serviceSlug, warnings);
}

function uniqueSlug(key: string, name: string, usedSlugs: Set<string>): string {
	let slug = slugifyComposeKey(name) || slugifyComposeKey(key) || "service";
	let attempt = 2;
	while (usedSlugs.has(slug)) {
		slug = `${slug.slice(0, 60)}-${attempt}`;
		attempt += 1;
	}
	usedSlugs.add(slug);
	return slug;
}

function unsupportedWarnings(raw: Record<string, unknown>): string[] {
	const warnings: string[] = [];
	const build = parseBuild(raw.build);
	if (build && !build.gitUrl) {
		warnings.push(
			`Built from ${build.context ? `"${build.context}"` : "a local path"}, which isn't something this host can clone : imported as a git-based service, set its repository on the Source tab.`,
		);
	}
	for (const [composeKey, message] of Object.entries(UNSUPPORTED_KEYS)) {
		if (raw[composeKey] !== undefined) {
			warnings.push(`${composeKey}: ${message}.`);
		}
	}
	return warnings;
}

/**
 * Collects port mappings from a compose service's `ports:` and `expose:`, warning
 * when none are found.
 *
 * @returns `published` is true when the service had host `ports:`, which the
 * import treats as meaning it should be publicly routed.
 */
function portsFor(
	raw: Record<string, unknown>,
	warnings: string[],
): { mappings: PortMapping[]; published: boolean } {
	const portEntries = Array.isArray(raw.ports) ? raw.ports : [];
	const exposeEntries = Array.isArray(raw.expose) ? raw.expose : [];
	const mappings = [...portEntries, ...exposeEntries]
		.map(parsePortEntry)
		.filter((m): m is PortMapping => m !== null);

	if (mappings.length === 0) {
		warnings.push(
			`No published port found : defaulting to ${DEFAULT_CONTAINER_PORT}, change it on the Networking tab.`,
		);
	}
	return { mappings, published: portEntries.length > 0 };
}

/**
 * Reads CPU and memory limits from `deploy.resources.limits`, falling back to the
 * legacy top-level `cpus` and `mem_limit` keys.
 */
function limitsFor(raw: Record<string, unknown>): {
	cpuLimit: string | null;
	memoryLimitMb: number | null;
} {
	const deploy = isRecord(raw.deploy) ? raw.deploy : {};
	const resources = isRecord(deploy.resources) ? deploy.resources : {};
	const limits = isRecord(resources.limits) ? resources.limits : {};
	const rawCpus = limits.cpus ?? raw.cpus;

	return {
		cpuLimit:
			typeof rawCpus === "string" || typeof rawCpus === "number"
				? String(rawCpus)
				: null,
		memoryLimitMb:
			parseMemoryLimit(limits.memory) ?? parseMemoryLimit(raw.mem_limit),
	};
}

/**
 * Builds the service draft for one compose service entry, claiming a unique slug
 * in `usedSlugs` and collecting warnings for anything that can't be reproduced.
 * A service without an image gets `<slug>:latest`.
 */
function draftFor(
	key: string,
	raw: Record<string, unknown>,
	usedSlugs: Set<string>,
	suppliedEnvFiles: Record<string, string>,
): ComposeServiceDraft {
	const name =
		typeof raw.container_name === "string" ? raw.container_name : key;
	const slug = uniqueSlug(key, name, usedSlugs);
	const warnings = unsupportedWarnings(raw);

	const image =
		typeof raw.image === "string" && raw.image.trim()
			? raw.image.trim()
			: `${slug}:latest`;
	const { image: imageName, tag } = splitImageRef(image);

	const { mappings, published } = portsFor(raw, warnings);
	const containerPort = mappings[0]?.port ?? DEFAULT_CONTAINER_PORT;
	const networkMode = raw.network_mode === "host" ? "host" : "bridge";
	const volumes = (Array.isArray(raw.volumes) ? raw.volumes : [])
		.map((entry) => parseVolumeEntry(entry, slug, warnings))
		.filter((v): v is ComposeVolumeDraft => v !== null);

	const envFiles = resolveEnvFiles(raw.env_file, suppliedEnvFiles, warnings);

	return {
		build: parseBuild(raw.build),
		capAdd: stringList(raw.cap_add),
		command: argvFrom(raw.command),
		containerPort,
		dependsOn: parseDependsOn(raw.depends_on),
		devices: parseDevices(raw.devices),
		dnsResolvable: networkMode === "bridge" && published,
		domains: [],
		entrypoint: argvFrom(raw.entrypoint),
		envFiles: envFiles.envFiles,
		envVars: { ...envFiles.envVars, ...parseEnvironment(raw.environment) },
		files: [],
		image: imageName,
		key,
		labels: parseLabels(raw.labels, warnings),
		missingEnvFiles: envFiles.missing,
		name,
		networkMode,
		portProtocol: protocolFor(mappings),
		publishedPorts:
			networkMode === "host" ? [] : publishedPortsFor(mappings, containerPort),
		privileged: raw.privileged === true,
		registry: null,
		restartPolicy: parseRestart(raw.restart),
		runAsUser: parseUser(raw.user, warnings),
		slug,
		stripPathDomains: [],
		tag,
		volumes,
		warnings,
		...limitsFor(raw),
	};
}

/**
 * Parses a compose YAML file into an import plan: one service draft per usable
 * service (with unique slugs), the named volumes and networks it references, and
 * warnings for everything that isn't reproduced.
 *
 * @throws ComposeParseError When the text isn't YAML, has no `services:` block,
 * or contains no usable service definitions.
 */
export function parseComposeFile(
	text: string,
	options: ComposeParseOptions = {},
): ComposeImportPlan {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (err) {
		throw new ComposeParseError(
			`That isn't valid YAML: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!isRecord(doc)) {
		throw new ComposeParseError("That doesn't look like a compose file.");
	}
	const rawServices = doc.services;
	if (!isRecord(rawServices) || Object.keys(rawServices).length === 0) {
		throw new ComposeParseError("No `services:` block found in that file.");
	}

	const warnings: string[] = [];
	const usedSlugs = new Set<string>();
	const services: ComposeServiceDraft[] = [];
	for (const [key, value] of Object.entries(rawServices)) {
		if (!isRecord(value)) {
			warnings.push(`Skipped "${key}" : it isn't a service definition.`);
			continue;
		}
		services.push(draftFor(key, value, usedSlugs, options.envFiles ?? {}));
	}
	if (services.length === 0) {
		throw new ComposeParseError("No usable services found in that file.");
	}

	const networkNames = isRecord(doc.networks) ? Object.keys(doc.networks) : [];
	if (networkNames.length > 1) {
		warnings.push(
			"Every imported service joins one stack network : the file's separate networks aren't reproduced.",
		);
	}
	if (isRecord(doc.configs) || isRecord(doc.secrets)) {
		warnings.push("Top-level configs/secrets are not imported.");
	}

	const volumeNames = [
		...new Set(
			services.flatMap((svc) =>
				svc.volumes.filter((v) => v.kind === "volume").map((v) => v.source),
			),
		),
	];

	const missingEnvFiles = [
		...new Set(services.flatMap((svc) => svc.missingEnvFiles)),
	];

	return { missingEnvFiles, networkNames, services, volumeNames, warnings };
}

/**
 * Orders service drafts so each one comes after the services it `depends_on`,
 * keeping the original order otherwise. Unknown dependencies are ignored and
 * cycles are broken rather than rejected.
 */
export function orderByDependencies(
	services: ComposeServiceDraft[],
): ComposeServiceDraft[] {
	const byKey = new Map(services.map((svc) => [svc.key, svc]));
	const ordered: ComposeServiceDraft[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (svc: ComposeServiceDraft): void => {
		if (visited.has(svc.key) || visiting.has(svc.key)) {
			return;
		}
		visiting.add(svc.key);
		for (const dep of svc.dependsOn) {
			const target = byKey.get(dep);
			if (target) {
				visit(target);
			}
		}
		visiting.delete(svc.key);
		visited.add(svc.key);
		ordered.push(svc);
	};

	for (const svc of services) {
		visit(svc);
	}
	return ordered;
}
