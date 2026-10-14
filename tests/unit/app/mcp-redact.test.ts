import { describe, expect, test } from "bun:test";
import {
	isSecretName,
	looksLikeCredential,
	maskFileText,
	maskInlineSecrets,
	mergeEnvChanges,
	REDACTED,
	redactSecrets,
	redactText,
	restoreArgv,
	restoreFiles,
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

describe("a cron job's script source and files", () => {
	const source = [
		"export API_TOKEN=t0k3n",
		'const apiKey = "abc123";',
		"PORT=8080",
		"curl https://admin:hunter2@example.com",
	].join("\n");
	const files = [
		{
			content: "password: s3cret\nhost: db",
			mode: "600",
			path: "/app/config.yaml",
		},
		{ content: "TZ=UTC", path: "/app/.env" },
	];

	test("lose the values assigned to secret-looking names and their inline secrets", () => {
		expect(maskFileText(source)).toBe(
			[
				`export API_TOKEN=${REDACTED}`,
				`const apiKey = ${REDACTED}`,
				"PORT=8080",
				`curl https://admin:${REDACTED}@example.com`,
			].join("\n"),
		);
		const redacted = redactSecrets({ files, source }) as {
			files: { content: string; mode?: string; path: string }[];
			source: string;
		};
		expect(redacted.source).toBe(maskFileText(source));
		expect(redacted.files).toEqual([
			{
				content: `password: ${REDACTED}\nhost: db`,
				mode: "600",
				path: "/app/config.yaml",
			},
			{ content: "TZ=UTC", path: "/app/.env" },
		]);
		expect(JSON.stringify(redacted)).not.toMatch(/t0k3n|abc123|hunter2|s3cret/);
	});

	test("a plain path or hostname under source is left as is", () => {
		expect(redactSecrets({ source: "/srv/media" })).toEqual({
			source: "/srv/media",
		});
		expect(redactSecrets({ source: "old.example.com/blog" })).toEqual({
			source: "old.example.com/blog",
		});
	});

	test("sent back as read, they keep what's stored", () => {
		expect(
			restoreMaskedText("source", maskFileText(source), source, maskFileText),
		).toBe(source);
		const echoed = files.map((file) => ({
			...file,
			content: maskFileText(file.content),
		}));
		expect(restoreFiles(echoed, files)).toEqual(files);
		expect(
			restoreFiles([{ content: "new", path: "/app/new.txt" }], files),
		).toEqual([{ content: "new", path: "/app/new.txt" }]);
	});

	test("a placeholder that matches nothing stored is refused", () => {
		expect(() =>
			restoreFiles(
				[{ content: `password: ${REDACTED}`, path: "/app/other.yaml" }],
				files,
			),
		).toThrow(/other\.yaml/);
		expect(() =>
			restoreMaskedText("source", `TOKEN=${REDACTED}`, null, maskFileText),
		).toThrow(/source/);
	});
});

const randomToken = ["Xk3", "fP9", "qLm2", "Zr7T"].join("").repeat(4);

describe("env redaction by name and by value", () => {
	test("AUTH, COOKIE and SIGNING names are secret, a name that only configures one isn't", () => {
		for (const name of [
			"STREMTHRU_AUTH",
			"BASIC_AUTH",
			"AUTH_SECRET",
			"SESSION_COOKIE",
			"JWT_SIGNING_KEY",
			"DB_PASSPHRASE",
			"APP_CREDENTIALS",
		]) {
			expect(isSecretName(name)).toBe(true);
		}
		for (const name of [
			"OIDC_AUTH_URL",
			"BASIC_AUTH_ENABLED",
			"AUTH_PROVIDER",
			"COOKIE_DOMAIN",
			"PRIVATE_KEY_FILE",
		]) {
			expect(isSecretName(name)).toBe(false);
		}
	});

	test("a boolean or a number is never hidden by its name alone", () => {
		expect(
			redactSecrets({
				envVars: {
					API_KEY: "s3cret",
					GITEA__service__ENABLE_PASSWORD_SIGNIN_FORM: "false",
					PASSWORD_MIN_LENGTH: "12",
				},
			}),
		).toEqual({
			envVars: {
				API_KEY: REDACTED,
				GITEA__service__ENABLE_PASSWORD_SIGNIN_FORM: "false",
				PASSWORD_MIN_LENGTH: "12",
			},
		});
		expect(
			redactSecrets({
				envVars: { PIN: "1234" },
				secretEnvKeys: ["PIN"],
			}),
		).toEqual({ envVars: { PIN: REDACTED }, secretEnvKeys: ["PIN"] });
	});

	test("a credential-looking value is hidden whatever its name", () => {
		const env = {
			HOSTNAME: "media.example.com",
			IMAGE: "ghcr.io/Owner/App2:v1.2.3",
			LISTEN: "0.0.0.0:8080",
			PROXY_LOGIN: `admin:${randomToken}`,
			RELEASE: "v2.14.3-Beta1Build20240101Final",
			SESSION_ID_FORMAT: "550e8400-e29b-41d4-a716-446655440000",
			STORAGE: "/srv/Media/Library2024/Shows",
			UPSTREAM: randomToken,
		};
		expect(
			(redactSecrets({ envVars: env }) as { envVars: Record<string, string> })
				.envVars,
		).toEqual({
			...env,
			PROXY_LOGIN: REDACTED,
			UPSTREAM: REDACTED,
		});
		expect(looksLikeCredential("sha256:abc123def4567890abc123def4567890")).toBe(
			false,
		);
		expect(looksLikeCredential("postgres:16")).toBe(false);
	});

	test("echoing a credential-looking value back keeps it", () => {
		const stored = { PROXY_LOGIN: `admin:${randomToken}` };
		expect(mergeEnvChanges({ PROXY_LOGIN: REDACTED }, stored)).toEqual(stored);
	});
});

describe("error events, logs and icons", () => {
	test("an error event loses its OAuth code, credential headers and cookies", () => {
		const event = {
			breadcrumbs: {
				values: [
					{
						category: "fetch",
						data: {
							method: "GET",
							url: "https://api.example.com/v1/items?api_key=abc123&page=2",
						},
					},
					{
						category: "console",
						message:
							'{"url":"https://app.example.com/auth/callback?code=4/0AbCd&state=xyz"}',
					},
				],
			},
			request: {
				cookies: { session: "s3cret" },
				data: "username=admin&password=hunter2",
				headers: {
					Accept: "text/html",
					Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9",
					Cookie: "sid=s3cret",
					"X-Api-Key": "k3y",
				},
				query_string: "code=4/0AbCd&state=xyz&lang=en",
				url: "https://app.example.com/auth/callback?code=4/0AbCd&state=xyz&lang=en",
			},
		};
		const redacted = redactSecrets({ event }) as {
			event: {
				breadcrumbs: typeof event.breadcrumbs;
				request: Record<string, unknown>;
			};
		};
		expect(redacted.event.request).toEqual({
			cookies: REDACTED,
			data: `username=admin&password=${REDACTED}`,
			headers: {
				Accept: "text/html",
				Authorization: REDACTED,
				Cookie: REDACTED,
				"X-Api-Key": REDACTED,
			},
			query_string: `code=${REDACTED}&state=${REDACTED}&lang=en`,
			url: `https://app.example.com/auth/callback?code=${REDACTED}&state=${REDACTED}&lang=en`,
		});
		const crumbs = redacted.event.breadcrumbs.values;
		expect(crumbs[0]?.data?.url).toBe(
			`https://api.example.com/v1/items?api_key=${REDACTED}&page=2`,
		);
		expect(crumbs[1]?.message).toBe(
			`{"url":"https://app.example.com/auth/callback?code=${REDACTED}&state=${REDACTED}"}`,
		);
		expect(JSON.stringify(redacted)).not.toMatch(
			/4\/0AbCd|xyz|s3cret|hunter2|k3y|abc123/,
		);
	});

	test("headers sent as pairs are masked too", () => {
		expect(
			redactSecrets({
				headers: [
					["Authorization", "Basic YWRtaW46aHVudGVyMg=="],
					["Host", "example.com"],
				],
			}),
		).toEqual({
			headers: [
				["Authorization", REDACTED],
				["Host", "example.com"],
			],
		});
	});

	test("a log line loses bearer tokens, token parameters and user:token@ credentials", () => {
		const log = [
			"GET /api Authorization: Bearer abc123def456ghi789",
			"POST /hook?token=t0k3n&id=4 200",
			"cloning admin:ghp_S3cretT0ken@github.com/me/repo",
			"exit code=1 after state change",
		].join("\n");
		expect(redactText(log)).toBe(
			[
				`GET /api Authorization: Bearer ${REDACTED}`,
				`POST /hook?token=${REDACTED}&id=4 200`,
				`cloning admin:${REDACTED}@github.com/me/repo`,
				"exit code=1 after state change",
			].join("\n"),
		);
		expect(maskInlineSecrets("Bearer token expired")).toBe(
			"Bearer token expired",
		);
		expect(maskInlineSecrets("DEBUG password=hunter2 user=me")).toBe(
			`DEBUG password=${REDACTED} user=me`,
		);
	});

	test("an uploaded icon is replaced by a label, a URL icon is kept", () => {
		expect(
			redactSecrets({ icon: "data:image/png;base64,iVBORw0KGgo=" }),
		).toEqual({ icon: "uploaded" });
		expect(redactSecrets({ icon: "https://cdn.example.com/a.svg" })).toEqual({
			icon: "https://cdn.example.com/a.svg",
		});
	});
});
