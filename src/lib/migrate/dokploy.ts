import { parse as parseYaml } from "yaml";
import type { BuildMethod } from "#lib/build-methods.js";
import {
	bindVolumeName,
	type ComposeFileDraft,
	type ComposeServiceDraft,
	type ComposeVolumeDraft,
} from "#lib/compose-import.js";
import { normalizeDomain } from "#lib/service-domains.js";
import {
	composeDrafts,
	imageSummary,
	isRow,
	joinPaths,
	type MigrationEntry,
	type MigrationEntryKind,
	num,
	parseEnvBlob,
	type RawRow,
	rows,
	singleDraft,
	sourceSlug,
	str,
	trimPath,
} from "./common";
import {
	attachComposeFileMounts,
	dokployFileMounts,
	dokployRegistry,
	dokployStartCommand,
	shellQuote,
} from "./dokploy-runtime";

export type DokployResourceType =
	| "application"
	| "compose"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

export interface DokployRef {
	id: string;
	name: string | null;
	projectName: string;
	type: DokployResourceType;
}

const LIST_KEYS: Record<string, DokployResourceType> = {
	applications: "application",
	compose: "compose",
	libsql: "libsql",
	mariadb: "mariadb",
	mongo: "mongo",
	mysql: "mysql",
	postgres: "postgres",
	redis: "redis",
};

/**
 * The id field name Dokploy uses for a resource type (`applicationId`,
 * `postgresId`, ...).
 */
export function dokployIdKey(type: DokployResourceType): string {
	return type === "application" ? "applicationId" : `${type}Id`;
}

function refsIn(container: RawRow, projectName: string): DokployRef[] {
	return Object.entries(LIST_KEYS).flatMap(([listKey, type]) =>
		rows(container[listKey]).flatMap((row) => {
			const id = str(row, dokployIdKey(type));
			return id ? [{ id, name: str(row, "name"), projectName, type }] : [];
		}),
	);
}

/**
 * Flattens Dokploy's `project.all` response into references to every
 * application, compose stack and database, reading them from each environment
 * when the project has environments and from the project itself otherwise.
 */
export function dokployRefs(projects: unknown[]): DokployRef[] {
	return projects.filter(isRow).flatMap((project) => {
		const projectName = str(project, "name") ?? "Dokploy";
		const environments = rows(project.environments);
		const containers = environments.length > 0 ? environments : [project];
		return containers.flatMap((container) => refsIn(container, projectName));
	});
}

/**
 * Converts a Dokploy resource's mounts into volume drafts: named volumes stay
 * named, bind mounts get a generated volume name, file mounts with content are
 * left to `dokployFileMounts`, and anything else is skipped with a warning. A
 * `:ro` suffix marks the mount read-only.
 */
function mountsFor(
	row: RawRow,
	slug: string,
	warnings: string[],
): ComposeVolumeDraft[] {
	const volumes: ComposeVolumeDraft[] = [];
	for (const mount of rows(row.mounts)) {
		const rawPath = str(mount, "mountPath");
		if (!rawPath) {
			continue;
		}
		const readOnly = rawPath.endsWith(":ro");
		const containerPath = rawPath.replace(/:(ro|rw)$/, "");
		const type = str(mount, "type");
		if (type === "file" && typeof mount.content === "string") {
			continue;
		}
		const volumeName = str(mount, "volumeName");
		const hostPath = str(mount, "hostPath");
		if (type === "volume" && volumeName) {
			volumes.push({
				containerPath,
				kind: "volume",
				name: volumeName,
				readOnly,
				source: volumeName,
			});
		} else if (type === "bind" && hostPath) {
			volumes.push({
				containerPath,
				kind: "bind",
				name: bindVolumeName(slug, containerPath),
				readOnly,
				source: hostPath,
			});
		} else {
			warnings.push(
				`The ${type ?? "unknown"} mount at ${containerPath} isn't carried over : recreate it on the Storage tab.`,
			);
		}
	}
	return volumes;
}

function publicPort(row: RawRow): number | null {
	for (const domain of rows(row.domains)) {
		const port = num(domain, "port");
		if (port) {
			return port;
		}
	}
	for (const port of rows(row.ports)) {
		const target = num(port, "targetPort");
		if (target) {
			return target;
		}
	}
	return null;
}

/**
 * A Dokploy domain row as a Homerun domain entry: its host, plus its path
 * when it routes one (`example.com/api`), whether Dokploy strips that path,
 * and a warning when it also rewrote the request to an internal path, which
 * isn't carried over. Null without a host.
 */
function dokployDomain(
	domain: RawRow,
): { entry: string; strip: boolean; warning: string | null } | null {
	const host = str(domain, "host");
	if (!host) {
		return null;
	}
	const path = (str(domain, "path") ?? "").replace(/^\/*/, "/");
	const entry = normalizeDomain(`${host}${path}`);
	const internalPath = str(domain, "internalPath");
	return {
		entry,
		strip: entry.includes("/") && domain.stripPath === true,
		warning:
			internalPath && internalPath !== "/"
				? `${entry} forwards to the internal path ${internalPath} on Dokploy, which isn't carried over : serve the app under that path itself.`
				: null,
	};
}

/** Every Dokploy domain of `row` as Homerun domain entries, the ones whose path is stripped, and what couldn't be carried over. */
function dokployDomains(row: RawRow): {
	domains: string[];
	stripPathDomains: string[];
	warnings: string[];
} {
	const entries = rows(row.domains).flatMap((domain) => {
		const parsed = dokployDomain(domain);
		return parsed ? [parsed] : [];
	});
	return {
		domains: entries.map((parsed) => parsed.entry),
		stripPathDomains: entries
			.filter((parsed) => parsed.strip)
			.map((parsed) => parsed.entry),
		warnings: entries.flatMap((parsed) =>
			parsed.warning ? [parsed.warning] : [],
		),
	};
}

function limits(row: RawRow): {
	cpuLimit: string | null;
	memoryLimitMb: number | null;
} {
	const memory = num(row, "memoryLimit");
	const cpu = num(row, "cpuLimit");
	return {
		cpuLimit: cpu ? String(cpu > 1000 ? cpu / 1e9 : cpu) : null,
		memoryLimitMb: memory
			? Math.max(
					1,
					Math.round(memory > 1_048_576 ? memory / 1_048_576 : memory),
				)
			: null,
	};
}

function nested(row: RawRow, key: string): RawRow {
	const value = row[key];
	return isRow(value) ? value : {};
}

export interface DokployGitSource {
	branch: string | null;
	buildPath: string | null;
	url: string | null;
}

/**
 * Resolves the repository URL, branch and build path of a Dokploy application
 * from the provider-specific fields of its source type (GitHub, GitLab, Gitea,
 * Bitbucket or custom git).
 *
 * @returns null for a non-git source type; `url` is null when the fields needed
 * to build it are missing.
 */
export function dokployGitSource(row: RawRow): DokployGitSource | null {
	const sourceType = str(row, "sourceType");
	const repoPath = (owner: string | null, repo: string | null) =>
		owner && repo ? `${owner}/${repo}` : null;
	switch (sourceType) {
		case "github": {
			const path = repoPath(str(row, "owner"), str(row, "repository"));
			const host =
				str(nested(row, "github"), "githubUrl") ?? "https://github.com";
			return {
				branch: str(row, "branch"),
				buildPath: str(row, "buildPath"),
				url: path ? `${host.replace(/\/+$/, "")}/${path}` : null,
			};
		}
		case "gitlab": {
			const path =
				str(row, "gitlabPathNamespace") ??
				repoPath(str(row, "gitlabOwner"), str(row, "gitlabRepository"));
			const host =
				str(nested(row, "gitlab"), "gitlabUrl") ?? "https://gitlab.com";
			return {
				branch: str(row, "gitlabBranch"),
				buildPath: str(row, "gitlabBuildPath"),
				url: path ? `${host.replace(/\/+$/, "")}/${path}` : null,
			};
		}
		case "gitea": {
			const path = repoPath(
				str(row, "giteaOwner"),
				str(row, "giteaRepository"),
			);
			const host = str(nested(row, "gitea"), "giteaUrl");
			return {
				branch: str(row, "giteaBranch"),
				buildPath: str(row, "giteaBuildPath"),
				url: path && host ? `${host.replace(/\/+$/, "")}/${path}` : null,
			};
		}
		case "bitbucket": {
			const path = repoPath(
				str(row, "bitbucketOwner"),
				str(row, "bitbucketRepositorySlug", "bitbucketRepository"),
			);
			return {
				branch: str(row, "bitbucketBranch"),
				buildPath: str(row, "bitbucketBuildPath"),
				url: path ? `https://bitbucket.org/${path}` : null,
			};
		}
		case "git":
			return {
				branch: str(row, "customGitBranch"),
				buildPath: str(row, "customGitBuildPath"),
				url: str(row, "customGitUrl"),
			};
		default:
			return null;
	}
}

interface AppOutcome {
	blocked: string | null;
	drafts: MigrationEntry["drafts"];
	summary: string;
}

interface AppContext {
	base: {
		command: string[] | null;
		cpuLimit: string | null;
		domains: string[];
		entrypoint: string[] | null;
		envVars: Record<string, string>;
		files: ComposeFileDraft[];
		memoryLimitMb: number | null;
		name: string;
		public: boolean;
		stripPathDomains: string[];
	};
	row: RawRow;
	slug: string;
	warnings: string[];
}

function blockedOutcome(blocked: string, summary: string): AppOutcome {
	return { blocked, drafts: [], summary };
}

/**
 * Drafts a Dokploy application deployed from a Docker image, carrying its
 * private registry credentials over. Blocked when no image is set.
 */
function imageApp({ base, row, slug, warnings }: AppContext): AppOutcome {
	const image = str(row, "dockerImage");
	if (!image) {
		return blockedOutcome(
			"Dokploy has no image set for this application.",
			"docker image",
		);
	}
	const draft = singleDraft({
		...base,
		containerPort: publicPort(row),
		image,
		registry: dokployRegistry(row, warnings),
		volumes: mountsFor(row, slug, warnings),
	});
	return { blocked: null, drafts: [draft], summary: imageSummary(draft) };
}

const DOKPLOY_BUILD_METHODS: Record<string, BuildMethod> = {
	dockerfile: "dockerfile",
	heroku_buildpacks: "heroku",
	nixpacks: "nixpacks",
	paketo_buildpacks: "paketo",
	railpack: "railpack",
};

/**
 * Drafts a Dokploy application built from a git source as a git-based service.
 * Blocked when the source has nothing to clone, uses a build type Homerun has
 * no builder for (a static build), or has no repository URL.
 */
function gitApp(
	{ base, row, slug, warnings }: AppContext,
	sourceType: string,
): AppOutcome {
	const git = dokployGitSource(row);
	if (!git) {
		return blockedOutcome(
			`Deployed from a "${sourceType}" source on Dokploy, which has nothing to pull or clone here.`,
			sourceType,
		);
	}
	const buildType = str(row, "buildType") ?? "dockerfile";
	const method = DOKPLOY_BUILD_METHODS[buildType];
	if (!method) {
		return blockedOutcome(
			`Built with ${buildType} on Dokploy : Homerun builds from a Dockerfile, Nixpacks, Railpack or Heroku/Paketo buildpacks.`,
			`git ${git.url ?? "repository"} · ${buildType}`,
		);
	}
	const herokuVersion = str(row, "herokuVersion");
	if (method === "heroku" && herokuVersion && herokuVersion !== "24") {
		warnings.push(
			`Built with the heroku/builder:${herokuVersion} stack on Dokploy : Homerun builds on heroku/builder:24.`,
		);
	}
	if (!git.url) {
		return blockedOutcome(
			"Dokploy didn't say which repository this builds from.",
			"git",
		);
	}
	if (sourceType !== "git") {
		warnings.push(
			`Cloned through Dokploy's ${sourceType} integration : a private repository needs a connected git provider here.`,
		);
	}
	const draft = singleDraft({
		...base,
		build: {
			context:
				method === "dockerfile"
					? joinPaths(git.buildPath, str(row, "dockerContextPath"))
					: trimPath(git.buildPath),
			dockerfile:
				method === "dockerfile" ? trimPath(str(row, "dockerfile")) : null,
			gitRef: git.branch,
			gitUrl: git.url,
			method,
		},
		containerPort: publicPort(row),
		image: null,
		volumes: mountsFor(row, slug, warnings),
	});
	return { blocked: null, drafts: [draft], summary: imageSummary(draft) };
}

const PROJECT_VARIABLE_RE = /\$\{\{/;

/**
 * Converts a Dokploy application detail row into a migration entry with one
 * service draft, built from its image or git source, carrying its start command
 * and file mounts over and warning about project-level variable references.
 */
export function dokployApplication(
	row: RawRow,
	projectName: string,
): MigrationEntry {
	const name = str(row, "name", "appName") ?? "unnamed";
	const { warnings, ...domains } = dokployDomains(row);
	const context: AppContext = {
		base: {
			envVars: parseEnvBlob(row.env),
			files: dokployFileMounts(row),
			name,
			...domains,
			public: rows(row.domains).length > 0,
			...dokployStartCommand(row),
			...limits(row),
		},
		row,
		slug: sourceSlug(name),
		warnings,
	};
	if (
		Object.values(context.base.envVars).some((value) =>
			PROJECT_VARIABLE_RE.test(value),
		)
	) {
		context.warnings.push(
			"Some variables reference Dokploy project or environment variables : fill those in by hand.",
		);
	}
	const sourceType = str(row, "sourceType") ?? "docker";
	const outcome =
		sourceType === "docker" ? imageApp(context) : gitApp(context, sourceType);
	return {
		...outcome,
		id: str(row, "applicationId") ?? `${projectName}-${name}`,
		kind: "application",
		name,
		projectName,
		warnings: context.warnings,
	};
}

interface DeclaredComposeVolume {
	external: boolean;
	name: string | null;
}

/**
 * Reads the top-level `volumes:` block of a compose file into a map of each
 * volume's explicit `name` and `external` flag. Invalid YAML yields an empty map.
 */
function declaredComposeVolumes(
	file: string,
): Map<string, DeclaredComposeVolume> {
	const declared = new Map<string, DeclaredComposeVolume>();
	let doc: unknown;
	try {
		doc = parseYaml(file);
	} catch {
		return declared;
	}
	const volumes = isRow(doc) && isRow(doc.volumes) ? doc.volumes : {};
	for (const [key, value] of Object.entries(volumes)) {
		const spec = isRow(value) ? value : {};
		declared.set(key, {
			external: spec.external === true || isRow(spec.external),
			name: typeof spec.name === "string" ? spec.name : null,
		});
	}
	return declared;
}

/**
 * Rewrites a compose named volume to the real Docker volume Dokploy created, so
 * the imported service reuses its data: an explicit `name:` wins, external
 * volumes keep their name, and anything else gets Dokploy's `<appName>_` project
 * prefix. Bind mounts pass through.
 */
export function dokployComposeVolume(
	volume: ComposeVolumeDraft,
	appName: string,
	declared: Map<string, DeclaredComposeVolume>,
): ComposeVolumeDraft {
	if (volume.kind !== "volume") {
		return volume;
	}
	const spec = declared.get(volume.source);
	if (spec?.name) {
		return { ...volume, source: spec.name };
	}
	if (spec?.external) {
		return volume;
	}
	return { ...volume, source: `${appName}_${volume.source}` };
}

function prefixComposeVolumes(
	drafts: ComposeServiceDraft[],
	file: string,
	appName: string | null,
): void {
	if (!appName) {
		return;
	}
	const declared = declaredComposeVolumes(file);
	for (const draft of drafts) {
		draft.volumes = draft.volumes.map((volume) =>
			dokployComposeVolume(volume, appName, declared),
		);
	}
}

/**
 * Converts a Dokploy compose stack into a migration entry by parsing its stored
 * compose file, remapping volume names to Dokploy's, and marking services that
 * have a Dokploy domain as public on that domain's port. Blocked when no compose
 * file is stored or the file can't be parsed.
 */
export function dokployCompose(
	row: RawRow,
	projectName: string,
): MigrationEntry {
	const name = str(row, "name", "appName") ?? "unnamed";
	const id = str(row, "composeId") ?? `${projectName}-${name}`;
	const base = { id, kind: "compose" as const, name, projectName };
	const file = str(row, "composeFile");
	if (!file) {
		return {
			...base,
			blocked:
				"Dokploy has no compose file stored for this stack (it's read from a repository at deploy time) : import the file with Import compose instead.",
			drafts: [],
			summary: `compose · ${str(row, "sourceType") ?? "unknown source"}`,
			warnings: [],
		};
	}
	const parsed = composeDrafts(
		file,
		parseEnvBlob(row.env),
		typeof row.env === "string" ? { ".env": row.env } : {},
	);
	prefixComposeVolumes(parsed.drafts, file, str(row, "appName"));
	attachComposeFileMounts(parsed, file, row);
	for (const domain of rows(row.domains)) {
		const target = str(domain, "serviceName");
		const draft =
			parsed.drafts.find((d) => d.key === target) ??
			(parsed.drafts.length === 1 ? parsed.drafts[0] : undefined);
		const port = num(domain, "port");
		const mapped = dokployDomain(domain);
		if (draft) {
			draft.dnsResolvable = true;
			if (mapped && !draft.domains.includes(mapped.entry)) {
				draft.domains.push(mapped.entry);
				if (mapped.strip) {
					draft.stripPathDomains.push(mapped.entry);
				}
				if (mapped.warning) {
					draft.warnings.push(mapped.warning);
				}
			}
			if (port) {
				draft.containerPort = port;
			}
		}
	}
	return {
		...base,
		blocked: parsed.error,
		drafts: parsed.drafts,
		summary: `compose · ${parsed.drafts.length} service(s)`,
		warnings: parsed.warnings,
	};
}

const DATABASES: Record<string, { env: Record<string, string>; port: number }> =
	{
		libsql: { env: {}, port: 8080 },
		mariadb: {
			env: {
				MARIADB_DATABASE: "databaseName",
				MARIADB_PASSWORD: "databasePassword",
				MARIADB_ROOT_PASSWORD: "databaseRootPassword",
				MARIADB_USER: "databaseUser",
			},
			port: 3306,
		},
		mongo: {
			env: {
				MONGO_INITDB_ROOT_PASSWORD: "databasePassword",
				MONGO_INITDB_ROOT_USERNAME: "databaseUser",
			},
			port: 27_017,
		},
		mysql: {
			env: {
				MYSQL_DATABASE: "databaseName",
				MYSQL_PASSWORD: "databasePassword",
				MYSQL_ROOT_PASSWORD: "databaseRootPassword",
				MYSQL_USER: "databaseUser",
			},
			port: 3306,
		},
		postgres: {
			env: {
				POSTGRES_DB: "databaseName",
				POSTGRES_PASSWORD: "databasePassword",
				POSTGRES_USER: "databaseUser",
			},
			port: 5432,
		},
		redis: { env: {}, port: 6379 },
	};

/**
 * Converts a Dokploy database into a single private service draft, mapping its
 * stored credentials onto the image's standard env vars, carrying its start
 * command over (Redis's password is applied through it, same as Dokploy does)
 * and warning about host port exposure, which doesn't. Blocked when no image
 * is set.
 */
export function dokployDatabase(
	row: RawRow,
	type: DokployResourceType,
	projectName: string,
): MigrationEntry {
	const name = str(row, "name", "appName") ?? type;
	const slug = sourceSlug(name);
	const spec = DATABASES[type] ?? { env: {}, port: 0 };
	const warnings: string[] = [];
	const envVars: Record<string, string> = {};
	for (const [envKey, field] of Object.entries(spec.env)) {
		const value = str(row, field);
		if (value) {
			envVars[envKey] = value;
		}
	}
	Object.assign(envVars, parseEnvBlob(row.env));
	const password = str(row, "databasePassword");
	const redisFallback =
		type === "redis" && password
			? `exec redis-server --requirepass ${shellQuote(password)}`
			: null;
	if (num(row, "externalPort")) {
		warnings.push(
			"Exposed on a host port on Dokploy : Homerun only reaches it over the internal network.",
		);
	}
	const image = str(row, "dockerImage");
	const draft = singleDraft({
		...limits(row),
		...dokployStartCommand(row, redisFallback),
		containerPort: spec.port || null,
		envVars,
		files: dokployFileMounts(row),
		image,
		name,
		public: false,
		volumes: mountsFor(row, slug, warnings),
	});
	return {
		blocked: image ? null : "Dokploy has no image set for this database.",
		drafts: image ? [draft] : [],
		id: str(row, dokployIdKey(type)) ?? `${projectName}-${name}`,
		kind: "database" satisfies MigrationEntryKind,
		name,
		projectName,
		summary: image ? `${type} · ${imageSummary(draft)}` : type,
		warnings,
	};
}

/** Dispatches a Dokploy resource detail to the converter for its type. */
export function dokployEntry(ref: DokployRef, detail: RawRow): MigrationEntry {
	if (ref.type === "application") {
		return dokployApplication(detail, ref.projectName);
	}
	if (ref.type === "compose") {
		return dokployCompose(detail, ref.projectName);
	}
	return dokployDatabase(detail, ref.type, ref.projectName);
}
