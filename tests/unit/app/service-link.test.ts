import { describe, expect, test } from "bun:test";
import { SECRET_MASK } from "../../../src/lib/formatting";
import {
	buildLinkEnv,
	buildLinkUrl,
	dataPathFor,
	defaultUrlKey,
	defaultVarPrefix,
	detectLinkEngine,
	internalUrl,
	linkFormatsFor,
	linkRoles,
	maskUrlPassword,
	requirePassword,
} from "../../../src/lib/service-link";

const postgres = {
	containerPort: 5432,
	envVars: {
		POSTGRES_DB: "app",
		POSTGRES_PASSWORD: "s3cr et",
		POSTGRES_USER: "app",
	},
	image: "postgres",
	name: "Postgres",
	slug: "db",
};

const redis = {
	containerPort: 6379,
	envVars: { REDIS_PASSWORD: "hunter2" },
	image: "redis:7-alpine",
	name: "Redis",
	slug: "cache",
};

const other = {
	containerPort: 3000,
	envVars: {},
	image: "ghcr.io/acme/api",
	name: "API",
	slug: "acme-api",
};

describe("dataPathFor", () => {
	test("each datastore keeps its data where its image expects", () => {
		expect(dataPathFor("postgres", "18-alpine")).toBe("/var/lib/postgresql");
		expect(dataPathFor("postgres", "latest")).toBe("/var/lib/postgresql");
		expect(dataPathFor("postgres", "17")).toBe("/var/lib/postgresql/data");
		expect(dataPathFor("timescale/timescaledb", "latest-pg16")).toBe(
			"/var/lib/postgresql/data",
		);
		expect(dataPathFor("mysql", "8")).toBe("/var/lib/mysql");
		expect(dataPathFor("mongo", "7")).toBe("/data/db");
		expect(dataPathFor("valkey/valkey", "8")).toBe("/data");
		expect(dataPathFor("memcached", "1")).toBeNull();
		expect(dataPathFor("ghcr.io/x/app", "latest")).toBeNull();
	});
});

describe("linkRoles", () => {
	const db = { image: "postgres", name: "db" };
	const app = { image: "ghcr.io/x/app", name: "app" };
	const cache = { image: "redis", name: "cache" };

	test("a database linked to an app puts its URL in the app", () => {
		expect(linkRoles(db, app)).toEqual({ consumer: app, provider: db });
	});

	test("an app linked to a database, or two datastores, keep the picked direction", () => {
		expect(linkRoles(app, db)).toEqual({ consumer: app, provider: db });
		expect(linkRoles(cache, db)).toEqual({ consumer: cache, provider: db });
	});
});

describe("detectLinkEngine", () => {
	test("recognises the common data stores", () => {
		expect(detectLinkEngine("postgres:17").id).toBe("postgres");
		expect(detectLinkEngine("timescale/timescaledb:latest-pg16").id).toBe(
			"postgres",
		);
		expect(detectLinkEngine("mariadb").id).toBe("mariadb");
		expect(detectLinkEngine("mysql:8").id).toBe("mysql");
		expect(detectLinkEngine("valkey/valkey").id).toBe("redis");
		expect(detectLinkEngine("mongo:7").id).toBe("mongo");
		expect(detectLinkEngine("rabbitmq:4-management").id).toBe("rabbitmq");
	});

	test("falls back to a generic HTTP service", () => {
		expect(detectLinkEngine("ghcr.io/acme/api").id).toBe("generic");
	});
});

describe("buildLinkEnv", () => {
	test("builds a connection URL against the internal hostname", () => {
		const engine = detectLinkEngine(postgres.image);
		expect(
			buildLinkEnv({
				format: "url",
				prefix: defaultVarPrefix(engine, postgres),
				target: postgres,
				urlKey: defaultUrlKey(engine, postgres),
			}),
		).toEqual([
			{ key: "POSTGRES_URL", value: "postgres://app:s3cr%20et@db:5432/app" },
		]);
	});

	test("builds a JDBC URL with credentials as query params", () => {
		expect(
			buildLinkEnv({
				format: "jdbc",
				prefix: "POSTGRES",
				target: postgres,
				urlKey: "DB_URL",
			}),
		).toEqual([
			{
				key: "DB_URL",
				value: "jdbc:postgresql://db:5432/app?user=app&password=s3cr%20et",
			},
		]);
	});

	test("builds one variable per value under a caller-chosen prefix", () => {
		expect(
			buildLinkEnv({
				format: "vars",
				prefix: "DB",
				target: postgres,
				urlKey: "",
			}),
		).toEqual([
			{ key: "DB_HOST", value: "db" },
			{ key: "DB_PORT", value: "5432" },
			{ key: "DB_USER", value: "app" },
			{ key: "DB_PASSWORD", value: "s3cr et" },
			{ key: "DB_DB", value: "app" },
		]);
	});

	test("omits an absent user from a redis URL", () => {
		expect(
			buildLinkEnv({
				format: "url",
				prefix: "REDIS",
				target: redis,
				urlKey: "REDIS_URL",
			}),
		).toEqual([{ key: "REDIS_URL", value: "redis://:hunter2@cache:6379" }]);
	});

	test("names a generic service's variables after its slug", () => {
		const engine = detectLinkEngine(other.image);
		expect(defaultUrlKey(engine, other)).toBe("ACME_API_URL");
		expect(
			buildLinkEnv({
				format: "url",
				prefix: defaultVarPrefix(engine, other),
				target: other,
				urlKey: defaultUrlKey(engine, other),
			}),
		).toEqual([{ key: "ACME_API_URL", value: "http://acme-api:3000" }]);
	});
});

describe("Redis passwords set on the command line", () => {
	test("reads --requirepass from a shell string or an argument list", () => {
		expect(
			requirePassword(["-c", "exec redis-server --requirepass 'gitea'"]),
		).toBe("gitea");
		expect(requirePassword(["redis-server", "--requirepass", "s3cret"])).toBe(
			"s3cret",
		);
		expect(requirePassword(["--requirepass=abc"])).toBe("abc");
		expect(requirePassword(['valkey-server --requirepass "q"'])).toBe("q");
		expect(requirePassword(null)).toBe("");
		expect(requirePassword(["redis-server"])).toBe("");
	});

	test("a link to a Valkey started with --requirepass carries the password", () => {
		const valkey = {
			command: ["-c", "exec redis-server --requirepass 'gitea'"],
			containerPort: 6379,
			envVars: {},
			image: "valkey/valkey:9",
			name: "Cache",
			slug: "gitea-redis",
		};
		expect(
			buildLinkEnv({
				format: "url",
				prefix: "REDIS",
				target: valkey,
				urlKey: "REDIS_URL",
			}),
		).toEqual([{ key: "REDIS_URL", value: "redis://:gitea@gitea-redis:6379" }]);
	});

	test("KeyDB and Garnet are Redis-compatible", () => {
		expect(detectLinkEngine("eqalpha/keydb").id).toBe("redis");
		expect(detectLinkEngine("ghcr.io/microsoft/garnet").id).toBe("redis");
	});
});

describe("URLs other services use", () => {
	test("Postgres comes as both postgres:// and postgresql://", () => {
		const engine = detectLinkEngine(postgres.image);
		expect(buildLinkUrl(engine, postgres, "url")).toBe(
			"postgres://app:s3cr%20et@db:5432/app",
		);
		expect(buildLinkUrl(engine, postgres, "postgresql")).toBe(
			"postgresql://app:s3cr%20et@db:5432/app",
		);
		expect(linkFormatsFor(engine).map(([value]) => value)).toEqual([
			"url",
			"postgresql",
			"jdbc",
			"vars",
		]);
		expect(
			linkFormatsFor(detectLinkEngine(redis.image)).map(([value]) => value),
		).toEqual(["url", "vars"]);
		expect(
			buildLinkEnv({
				format: "postgresql",
				prefix: "POSTGRES",
				target: postgres,
				urlKey: "DATABASE_URL",
			}),
		).toEqual([
			{ key: "DATABASE_URL", value: "postgresql://app:s3cr%20et@db:5432/app" },
		]);
	});

	test("the internal URL carries a datastore's credentials, masked for display", () => {
		const url = internalUrl(redis);
		expect(url).toBe("redis://:hunter2@cache:6379");
		expect(maskUrlPassword(url)).toBe(`redis://:${SECRET_MASK}@cache:6379`);
		expect(maskUrlPassword(internalUrl(postgres))).toBe(
			`postgres://app:${SECRET_MASK}@db:5432/app`,
		);
		expect(
			internalUrl({
				containerPort: 3000,
				envVars: {},
				image: "ghcr.io/acme/web",
				name: "Web",
				slug: "web",
			}),
		).toBe("http://web:3000");
	});
});
