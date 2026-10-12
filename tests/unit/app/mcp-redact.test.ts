import { describe, expect, test } from "bun:test";
import {
	isSecretName,
	maskInlineSecrets,
	mergeEnvChanges,
	REDACTED,
	redactSecrets,
	redactText,
	restoreArgv,
	restoreMaskedText,
} from "../../../src/lib/server/mcp-redact";

const stored = {
	ADMIN_KEY: "s3cret",
	DATABASE_URI:
		"postgres://aiometadata:hunter2@aio-metadata-db:5432/aiometadata",
	GITEA__cache__HOST:
		"redis://:gitea@gitea-redis:6379/0?pool_size=100&idle_timeout=180s",
	LOG_LEVEL: "info",
	SSH_PORT: "2222",
	TZ: "Europe/Paris",
};

describe("MCP secret redaction", () => {
	test("hides secret-looking vars, keeps the rest readable, masks only URL passwords", () => {
		const redacted = redactSecrets({
			envVars: stored,
			name: "gitea",
			registryPasswordEnc: "enc",
		}) as { envVars: Record<string, string> };
		expect(redacted.envVars).toEqual({
			ADMIN_KEY: REDACTED,
			DATABASE_URI: `postgres://aiometadata:${REDACTED}@aio-metadata-db:5432/aiometadata`,
			GITEA__cache__HOST: `redis://:${REDACTED}@gitea-redis:6379/0?pool_size=100&idle_timeout=180s`,
			LOG_LEVEL: "info",
			SSH_PORT: "2222",
			TZ: "Europe/Paris",
		});
		expect(redacted).not.toHaveProperty("registryPasswordEnc");
		expect(JSON.stringify(redacted)).not.toMatch(/s3cret|hunter2|:gitea@/);
	});

	test("names are read by their parts, not as substrings", () => {
		for (const name of [
			"POSTGRES_PASSWORD",
			"apiKey",
			"GITHUB_TOKEN",
			"JWT_SECRET",
			"AWS_SECRET_ACCESS_KEY",
			"DB_PASS",
			"PRIVATE_KEY",
		]) {
			expect(isSecretName(name)).toBe(true);
		}
		for (const name of ["TZ", "PORT", "SSH_PORT", "KEYCLOAK_URL", "MONKEY"]) {
			expect(isSecretName(name)).toBe(false);
		}
	});

	test("password arguments in a command are masked", () => {
		expect(
			redactSecrets({
				command: ["-c", "exec redis-server --requirepass 'gitea'"],
				entrypoint: ["valkey-server", "--requirepass", "s3cret"],
			}),
		).toEqual({
			command: ["-c", `exec redis-server --requirepass ${REDACTED}`],
			entrypoint: ["valkey-server", "--requirepass", REDACTED],
		});
		expect(maskInlineSecrets("--auth Password --password=abc")).toBe(
			`--auth Password --password=${REDACTED}`,
		);
	});

	test("a var marked secret is hidden whatever its name, in a service and a config", () => {
		expect(
			redactSecrets({
				envVars: { TMDB_API: "abc123", TZ: "Europe/Paris" },
				secretEnvKeys: ["TMDB_API"],
			}),
		).toEqual({
			envVars: { TMDB_API: REDACTED, TZ: "Europe/Paris" },
			secretEnvKeys: ["TMDB_API"],
		});
		expect(
			redactSecrets({
				env: { secretKeys: ["TMDB_API"], vars: { TMDB_API: "abc123" } },
			}),
		).toEqual({
			env: { secretKeys: ["TMDB_API"], vars: { TMDB_API: REDACTED } },
		});
	});

	test("a shell command, a log and a run's output lose their inline secrets", () => {
		expect(
			redactSecrets({
				command: "pg_dump postgres://app:hunter2@db/app",
				log: "redis-server --requirepass s3cret",
				output: "dial redis://:gitea@cache:6379",
			}),
		).toEqual({
			command: `pg_dump postgres://app:${REDACTED}@db/app`,
			log: `redis-server --requirepass ${REDACTED}`,
			output: `dial redis://:${REDACTED}@cache:6379`,
		});
	});

	test("a non-JSON body still loses its inline secrets", () => {
		expect(redactText("dial redis://:gitea@gitea-redis:6379 failed")).toBe(
			`dial redis://:${REDACTED}@gitea-redis:6379 failed`,
		);
	});
});

describe("update_service's env merge", () => {
	test("echoing the redacted config back keeps every stored secret", () => {
		const echoed = (
			redactSecrets({ envVars: stored }) as { envVars: Record<string, string> }
		).envVars;
		expect(mergeEnvChanges({ ...echoed, TZ: "UTC" }, stored)).toEqual({
			...stored,
			TZ: "UTC",
		});
	});

	test("sending one var changes only that one, null deletes", () => {
		const { SSH_PORT: _dropped, ...rest } = stored;
		expect(
			mergeEnvChanges({ LOG_LEVEL: "debug", SSH_PORT: null }, stored),
		).toEqual({ ...rest, LOG_LEVEL: "debug" });
		expect(
			Object.keys(mergeEnvChanges({ SSH_PORT: null }, stored)),
		).not.toContain("SSH_PORT");
	});

	test("a placeholder that matches nothing stored is refused, not written", () => {
		expect(() => mergeEnvChanges({ NEW_TOKEN: REDACTED }, stored)).toThrow(
			/NEW_TOKEN/,
		);
		expect(() =>
			mergeEnvChanges(
				{ DATABASE_URI: `postgres://other:${REDACTED}@db:5432/x` },
				stored,
			),
		).toThrow(/DATABASE_URI/);
	});

	test("echoing a marked-secret var back keeps its stored value", () => {
		const stored = { TMDB_API: "abc123" };
		const secret = new Set(["TMDB_API"]);
		expect(mergeEnvChanges({ TMDB_API: REDACTED }, stored, secret)).toEqual(
			stored,
		);
		expect(() => mergeEnvChanges({ TMDB_API: REDACTED }, stored)).toThrow();
	});

	test("a redacted password argument keeps the stored one", () => {
		const command = ["valkey-server", "--requirepass", "s3cret"];
		expect(
			restoreArgv(["valkey-server", "--requirepass", REDACTED], command),
		).toEqual(command);
		expect(() => restoreArgv(["--password", REDACTED], null)).toThrow();
	});
});

describe("update_cron_job's command", () => {
	const stored = "pg_dump postgres://app:hunter2@db/app";

	test("sent back as read, it keeps the stored one", () => {
		expect(
			restoreMaskedText("command", maskInlineSecrets(stored), stored),
		).toBe(stored);
		expect(restoreMaskedText("command", "echo hi", stored)).toBe("echo hi");
	});

	test("a placeholder that matches nothing stored is refused", () => {
		expect(() =>
			restoreMaskedText("command", `curl -u a:${REDACTED}@x`, stored),
		).toThrow(/command/);
		expect(() => restoreMaskedText("command", `x ${REDACTED}`, null)).toThrow();
	});
});
