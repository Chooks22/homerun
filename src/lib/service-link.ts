import type { ParsedEnvVar } from "#lib/env-parse.js";
import { SECRET_MASK } from "#lib/formatting.js";

export type LinkFormat = "url" | "postgresql" | "jdbc" | "vars";

export type LinkEngineId =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "rabbitmq"
	| "generic";

export interface LinkEngine {
	defaultPort: number;
	defaultUrlKey: string;
	defaultVarPrefix: string;
	id: LinkEngineId;
	label: string;
	supportsJdbc: boolean;
}

export interface LinkTargetService {
	command?: string[] | null;
	containerPort: number;
	envVars: Record<string, string>;
	image: string;
	name: string;
	slug: string;
}

export interface BuildLinkEnvParams {
	format: LinkFormat;
	prefix: string;
	target: LinkTargetService;
	urlKey: string;
}

const ENGINES: Record<LinkEngineId, LinkEngine> = {
	generic: {
		defaultPort: 80,
		defaultUrlKey: "SERVICE_URL",
		defaultVarPrefix: "SERVICE",
		id: "generic",
		label: "HTTP service",
		supportsJdbc: false,
	},
	mariadb: {
		defaultPort: 3306,
		defaultUrlKey: "MYSQL_URL",
		defaultVarPrefix: "MYSQL",
		id: "mariadb",
		label: "MariaDB",
		supportsJdbc: true,
	},
	mongo: {
		defaultPort: 27_017,
		defaultUrlKey: "MONGO_URL",
		defaultVarPrefix: "MONGO",
		id: "mongo",
		label: "MongoDB",
		supportsJdbc: false,
	},
	mysql: {
		defaultPort: 3306,
		defaultUrlKey: "MYSQL_URL",
		defaultVarPrefix: "MYSQL",
		id: "mysql",
		label: "MySQL",
		supportsJdbc: true,
	},
	postgres: {
		defaultPort: 5432,
		defaultUrlKey: "POSTGRES_URL",
		defaultVarPrefix: "POSTGRES",
		id: "postgres",
		label: "PostgreSQL",
		supportsJdbc: true,
	},
	rabbitmq: {
		defaultPort: 5672,
		defaultUrlKey: "AMQP_URL",
		defaultVarPrefix: "AMQP",
		id: "rabbitmq",
		label: "RabbitMQ",
		supportsJdbc: false,
	},
	redis: {
		defaultPort: 6379,
		defaultUrlKey: "REDIS_URL",
		defaultVarPrefix: "REDIS",
		id: "redis",
		label: "Redis",
		supportsJdbc: false,
	},
};

const IMAGE_MATCHERS: Array<[RegExp, LinkEngineId]> = [
	[/(^|\/)(timescale\/timescaledb|postgis\/postgis|.*postgres.*)/, "postgres"],
	[/(^|\/).*mariadb.*/, "mariadb"],
	[/(^|\/).*(mysql|percona).*/, "mysql"],
	[/(^|\/).*(mongo).*/, "mongo"],
	[/(^|\/).*(redis|valkey|dragonfly|keydb|garnet).*/, "redis"],
	[/(^|\/).*(rabbitmq).*/, "rabbitmq"],
];

/**
 * Guesses which datastore a service runs from its image name (Postgres and its
 * forks, MySQL/Percona, MariaDB, MongoDB, Redis-compatibles, RabbitMQ), falling
 * back to a generic HTTP service.
 */
export function detectLinkEngine(image: string): LinkEngine {
	const normalized = image.toLowerCase();
	for (const [pattern, id] of IMAGE_MATCHERS) {
		if (pattern.test(normalized)) {
			return ENGINES[id];
		}
	}
	return ENGINES.generic;
}

/**
 * Whether an image looks like a datastore. Used for defaults that should be
 * private: a Postgres or Redis has no business answering on a public
 * hostname just because the wizard's DNS checkbox starts checked.
 */
export function isDatabaseImage(image: string): boolean {
	return (
		detectLinkEngine(image).id !== "generic" ||
		/(^|\/)[^/]*memcached/.test(image.toLowerCase())
	);
}

const DATA_PATHS: Partial<Record<LinkEngineId, string>> = {
	mariadb: "/var/lib/mysql",
	mongo: "/data/db",
	mysql: "/var/lib/mysql",
	rabbitmq: "/var/lib/rabbitmq",
	redis: "/data",
};

/**
 * Where a datastore image keeps its data, for the volume a new database or
 * cache gets by default; null for anything else, memcached included (it
 * holds nothing worth keeping). Postgres 18 moved its data under a
 * versioned directory and wants `/var/lib/postgresql` mounted, while older
 * majors still declare `/var/lib/postgresql/data` as their volume, so the
 * tag decides (`17-alpine`, `latest-pg16`; no version means the newest).
 */
export function dataPathFor(image: string, tag: string): string | null {
	const engine = detectLinkEngine(image).id;
	if (engine !== "postgres") {
		return DATA_PATHS[engine] ?? null;
	}
	const major = Number(/(?:^|pg)(\d+)/.exec(tag)?.[1] ?? Number.NaN);
	return major < 18 ? "/var/lib/postgresql/data" : "/var/lib/postgresql";
}

/**
 * Who gets the connection variables when `source` is linked to `target`: the
 * source, unless it's a database or cache linked to something that isn't, in
 * which case the app gets the database's URL rather than the other way round.
 */
export function linkRoles<T extends { image: string }>(
	source: T,
	target: T,
): { consumer: T; provider: T } {
	return isDatabaseImage(source.image) && !isDatabaseImage(target.image)
		? { consumer: target, provider: source }
		: { consumer: source, provider: target };
}

/**
 * Turns a service slug into an env var name prefix: uppercase, underscores for
 * anything non-alphanumeric, and `SVC_` prepended when it wouldn't start with a
 * letter.
 */
export function envKeyPrefix(slug: string): string {
	const cleaned = slug
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return /^[A-Z]/.test(cleaned) ? cleaned : `SVC_${cleaned}`;
}

/**
 * The default prefix for a link's individual `_HOST`/`_PORT`/... variables: the
 * engine's conventional one (`POSTGRES`, `REDIS`), or one derived from the slug
 * for a generic service.
 */
export function defaultVarPrefix(
	engine: LinkEngine,
	target: LinkTargetService,
): string {
	return engine.id === "generic"
		? envKeyPrefix(target.slug)
		: engine.defaultVarPrefix;
}

/**
 * The default env var name for a link's connection URL: the engine's
 * conventional one (`POSTGRES_URL`), or `<SLUG>_URL` for a generic service.
 */
export function defaultUrlKey(
	engine: LinkEngine,
	target: LinkTargetService,
): string {
	return engine.id === "generic"
		? `${envKeyPrefix(target.slug)}_URL`
		: engine.defaultUrlKey;
}

interface Credentials {
	database: string | null;
	password: string;
	scheme: string;
	user: string;
}

function firstOf(
	envVars: Record<string, string>,
	keys: string[],
	fallback = "",
): string {
	for (const key of keys) {
		const value = envVars[key];
		if (value) {
			return value;
		}
	}
	return fallback;
}

/**
 * Reads the URL scheme, user, password and database a target service was set up
 * with from the image's standard env vars, using each image's own defaults when
 * they're unset.
 */
function credentialsFor(
	engine: LinkEngine,
	target: LinkTargetService,
): Credentials {
	const env = target.envVars;
	switch (engine.id) {
		case "postgres":
			return {
				database: firstOf(
					env,
					["POSTGRES_DB"],
					firstOf(env, ["POSTGRES_USER"], "postgres"),
				),
				password: firstOf(env, ["POSTGRES_PASSWORD"]),
				scheme: "postgres",
				user: firstOf(env, ["POSTGRES_USER"], "postgres"),
			};
		case "mysql":
		case "mariadb":
			return {
				database: firstOf(env, ["MYSQL_DATABASE", "MARIADB_DATABASE"], "mysql"),
				password: firstOf(env, [
					"MYSQL_PASSWORD",
					"MARIADB_PASSWORD",
					"MYSQL_ROOT_PASSWORD",
					"MARIADB_ROOT_PASSWORD",
				]),
				scheme: "mysql",
				user: firstOf(env, ["MYSQL_USER", "MARIADB_USER"], "root"),
			};
		case "mongo":
			return {
				database: env.MONGO_INITDB_DATABASE || null,
				password: firstOf(env, ["MONGO_INITDB_ROOT_PASSWORD"]),
				scheme: "mongodb",
				user: firstOf(env, ["MONGO_INITDB_ROOT_USERNAME"], "root"),
			};
		case "redis":
			return {
				database: null,
				password: firstOf(
					env,
					["REDIS_PASSWORD", "VALKEY_PASSWORD"],
					requirePassword(target.command),
				),
				scheme: "redis",
				user: "",
			};
		case "rabbitmq":
			return {
				database: null,
				password: firstOf(env, ["RABBITMQ_DEFAULT_PASS"], "guest"),
				scheme: "amqp",
				user: firstOf(env, ["RABBITMQ_DEFAULT_USER"], "guest"),
			};
		default:
			return { database: null, password: "", scheme: "http", user: "" };
	}
}

/**
 * The password a Redis-compatible server is started with through
 * `--requirepass`, whether the command is an argument list or one shell
 * string (`sh -c "exec redis-server --requirepass 'secret'"`, what the Dokploy
 * and Coolify migrations write). Empty when there's none.
 */
export function requirePassword(command: string[] | null | undefined): string {
	const joined = (command ?? []).join(" ");
	const match = /--requirepass(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(
		joined,
	);
	return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function authorityFor(credentials: Credentials, host: string): string {
	if (!(credentials.user || credentials.password)) {
		return host;
	}
	const user = encodeURIComponent(credentials.user);
	const password = credentials.password
		? `:${encodeURIComponent(credentials.password)}`
		: "";
	return `${user}${password}@${host}`;
}

function jdbcDriver(engine: LinkEngine): string {
	return engine.id === "postgres" ? "postgresql" : "mysql";
}

/**
 * Builds the connection string another service uses to reach the target over
 * the internal network, addressed by its slug and container port, with
 * credentials taken from the target's env vars.
 *
 * @param format `url` for a scheme URL with credentials in the authority,
 * `postgresql` for the same with the `postgresql://` scheme some drivers
 * insist on (Postgres only; any other engine keeps its own), `jdbc` for a JDBC
 * URL with credentials as query parameters.
 */
export function buildLinkUrl(
	engine: LinkEngine,
	target: LinkTargetService,
	format: "url" | "postgresql" | "jdbc",
): string {
	const credentials = credentialsFor(engine, target);
	const port = target.containerPort || engine.defaultPort;
	const host = `${target.slug}:${port}`;
	const path = credentials.database ? `/${credentials.database}` : "";

	if (format === "jdbc") {
		const params = [
			credentials.user ? `user=${encodeURIComponent(credentials.user)}` : "",
			credentials.password
				? `password=${encodeURIComponent(credentials.password)}`
				: "",
		].filter(Boolean);
		const query = params.length > 0 ? `?${params.join("&")}` : "";
		return `jdbc:${jdbcDriver(engine)}://${host}${path}${query}`;
	}

	const scheme =
		format === "postgresql" && engine.id === "postgres"
			? "postgresql"
			: credentials.scheme;
	return `${scheme}://${authorityFor(credentials, host)}${path}`;
}

/**
 * The URL formats a link to this engine can be written in, for a picker:
 * Postgres gets both `postgres://` and `postgresql://` (drivers disagree on
 * which they accept), and JDBC for the engines that have a driver.
 */
export function linkFormatsFor(
	engine: LinkEngine | null,
): Array<[LinkFormat, string]> {
	return [
		[
			"url",
			engine?.id === "postgres"
				? "Connection URL (postgres://)"
				: "Connection URL",
		],
		...(engine?.id === "postgres"
			? ([["postgresql", "Connection URL (postgresql://)"]] as Array<
					[LinkFormat, string]
				>)
			: []),
		...(engine?.supportsJdbc
			? ([["jdbc", "JDBC URL"]] as Array<[LinkFormat, string]>)
			: []),
		["vars", "One variable per value"],
	];
}

/**
 * Builds the individual `<prefix>_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_DB`
 * variables for a link, omitting credentials the target doesn't have.
 */
function varRows(
	engine: LinkEngine,
	target: LinkTargetService,
	prefix: string,
): ParsedEnvVar[] {
	const credentials = credentialsFor(engine, target);
	const rows: ParsedEnvVar[] = [
		{ key: `${prefix}_HOST`, value: target.slug },
		{
			key: `${prefix}_PORT`,
			value: String(target.containerPort || engine.defaultPort),
		},
	];
	if (credentials.user) {
		rows.push({ key: `${prefix}_USER`, value: credentials.user });
	}
	if (credentials.password) {
		rows.push({ key: `${prefix}_PASSWORD`, value: credentials.password });
	}
	if (credentials.database) {
		rows.push({ key: `${prefix}_DB`, value: credentials.database });
	}
	return rows;
}

/**
 * Builds the env vars a service link injects into the consuming service: a
 * single URL variable for the `url`/`jdbc` formats, or split host/port/credential
 * variables for `vars`.
 */
export function buildLinkEnv(params: BuildLinkEnvParams): ParsedEnvVar[] {
	const engine = detectLinkEngine(params.target.image);
	if (params.format === "vars") {
		return varRows(engine, params.target, params.prefix);
	}
	return [
		{
			key: params.urlKey,
			value: buildLinkUrl(engine, params.target, params.format),
		},
	];
}

/**
 * The address other services reach this one at: a datastore's full connection
 * URL, credentials included (what a consumer actually needs to paste), or
 * `http://<slug>:<port>` for anything else.
 */
export function internalUrl(target: LinkTargetService): string {
	const engine = detectLinkEngine(target.image);
	return engine.id === "generic"
		? `http://${target.slug}:${target.containerPort}`
		: buildLinkUrl(engine, target, "url");
}

/** A URL with the password in its authority replaced by dots, for display. */
export function maskUrlPassword(url: string): string {
	return url.replace(/(:\/\/[^:/@]*:)[^@/]+@/, `$1${SECRET_MASK}@`);
}
