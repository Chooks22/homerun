import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import Bun from "bun";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Only ever called when the YAML config's docker.socketPath is unset : an
 * explicit value always wins outright, this never overrides one. Real user
 * report this fixes: a bare "/var/run/docker.sock" default doesn't match the
 * active Docker context on plenty of real setups (OrbStack, Docker Desktop,
 * Colima on macOS, a non-default context on Linux), so both this app *and*
 * the standalone agent (see agent/config.ts's parallel copy, kept in sync by
 * hand) silently pointed at a socket that isn't there. Detection order
 * mirrors what the `docker` CLI itself effectively uses:
 *
 * 1. `DOCKER_HOST=unix://...`, docker's own standard env var, if set — this
 *    is docker's own convention, not app config, so it's read from the
 *    environment deliberately, unlike everything else in this file.
 * 2. `docker context inspect`, the actual current context.
 * 3. A handful of common non-default socket locations, checked for
 *    existence (covers a minimal container with only the socket
 *    bind-mounted in, no `docker` CLI at all).
 * 4. The original hardcoded default, as the final fallback.
 */
/**
 * The bearer token for the worker's Docker control API, derived from the auth
 * secret the app and the worker must already agree on.
 *
 * This is what makes the pair zero-configuration: neither side is told the
 * token and no file passes between them, they both compute the same one from
 * `AUTH_SECRET` (the identical derivation lives in Go, see
 * `httpapi.DeriveToken`). It's an HMAC rather than the secret itself so a
 * leaked control token doesn't also hand over the key every `*Enc` column is
 * encrypted with. `WORKER_TOKEN` still wins, for anyone who'd rather rotate
 * the two independently.
 */
function deriveWorkerToken(secret: string): string {
	return createHmac("sha256", secret)
		.update("homerun-worker-control")
		.digest("hex");
}

function detectDockerSocketPath(): string {
	const dockerHost = Bun.env.DOCKER_HOST;
	if (dockerHost?.startsWith("unix://")) {
		return dockerHost.slice("unix://".length);
	}

	try {
		const result = Bun.spawnSync([
			"docker",
			"context",
			"inspect",
			"--format",
			"{{.Endpoints.docker.Host}}",
		]);
		if (result.exitCode === 0) {
			const host = result.stdout.toString().trim();
			if (host.startsWith("unix://")) {
				return host.slice("unix://".length);
			}
		}
	} catch {
		// `docker` isn't installed/on PATH : fall through to path probing.
	}

	const candidates = [
		"/var/run/docker.sock",
		`${homedir()}/.orbstack/run/docker.sock`,
		`${homedir()}/.docker/run/docker.sock`,
		`${homedir()}/.colima/default/docker.sock`,
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return "/var/run/docker.sock";
}

/**
 * The shape of the YAML config file (`homerun.yaml` by default, see
 * `CONFIG_FILE` below) : every field optional, nothing here is required to
 * be present. Deliberately excludes `databaseUrl`, `auth.secret` and `port`
 * : those stay env-only, `DATABASE_URL`/`AUTH_SECRET`/`PORT`, the same "has
 * to be known before the file/DB it configures is even reachable" carve-out
 * this module has always documented for the DB-backed instance-settings
 * override system. Exported so `scripts/generate-config-schema.ts` can turn
 * it into the JSON Schema `homerun.example.yaml` references for editor
 * linting/autocomplete — every field staying plain `.optional()` (no
 * `.default()`) here matters : zod's JSON Schema generator lists any
 * `.default()`-wrapped field as `required` (with a `default` annotation),
 * which editors then flag as "missing" the moment it's actually omitted.
 * Defaults are applied separately, in `parseConfig()`, against `configSchema`
 * below instead.
 */
export const yamlConfigSchema = z.object({
	auth: z
		.object({
			// Widens the session cookie to every subdomain of baseDomain so a
			// signed-in admin is recognized on a gated deployed service's own
			// subdomain too (docker/labels.ts's authRequired) ; off by default,
			// see docs/login-wall.md before turning this on.
			crossSubdomainCookies: z.boolean().optional(),
			// Unset lets better-auth derive the origin from each incoming
			// request instead (auth.ts's buildAuth()), correct for dev and the
			// common single-domain prod case.
			origin: z.string().optional(),
		})
		.optional(),
	// URL Traefik's forwardAuth middleware calls to gatekeep a service with
	// authRequired=true, must be reachable from *inside* the Traefik
	// container. Unset default is computed at parse time from PORT (env).
	authCheckUrl: z.string().optional(),
	baseDomain: z.string().optional(),
	docker: z
		.object({
			networkName: z.string().optional(),
			socketPath: z.string().optional(),
		})
		.optional(),
	logFormat: z.enum(["console", "json"]).optional(),
	logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
	smtp: z
		.object({
			enabled: z.boolean().optional(),
			from: z.string().optional(),
			host: z.string().optional(),
			password: z.string().optional(),
			port: z.number().optional(),
			secure: z.boolean().optional(),
			user: z.string().optional(),
		})
		.optional(),
	traefik: z
		.object({
			acmeEmail: z.string().optional(),
			certResolver: z.string().optional(),
			// Where custom SSL cert/key files + per-domain dynamic-config YAML
			// get written (docker/custom-ssl.ts). Unset makes the feature a
			// no-op ; an opt-in the admin performs themselves, this app never
			// touches the Traefik container's own config.
			dynamicConfigDir: z.string().optional(),
			entrypoint: z.string().optional(),
		})
		.optional(),
	worker: z
		.object({
			token: z.string().optional(),
			url: z.string().optional(),
		})
		.optional(),
});

/** The fully-resolved runtime shape, every field defaulted : what `parseConfig()` builds from the YAML file (validated above) plus the env-only fields. */
const configSchema = z.object({
	auth: z.object({
		crossSubdomainCookies: z.boolean().default(false),
		oauthProviders: z
			.array(
				z.object({
					clientId: z.string(),
					clientSecret: z.string(),
					discoveryUrl: z.string(),
					name: z.string(),
					enabled: z.boolean().default(false),
					pkce: z.boolean().default(true),
					scopes: z.array(z.string()).default([]),
					discoveredTokenAuth: z.array(z.string()).default([]),
					label: z.string().default(""),
					signOutOfProvider: z.boolean().default(false),
					tokenAuthMethod: z.enum(["auto", "basic", "post"]).default("auto"),
				}),
			)
			.default([]),
		origin: z.string().optional(),
		secret: z.string().default("default-secret"),
	}),
	authCheckUrl: z.string(),
	baseDomain: z.string().default("localhost"),
	dataDir: z.string().default("./data"),
	databaseUrl: z
		.string()
		.default("postgres://homerun:homerun@localhost:5432/homerun"),
	docker: z
		.object({
			networkName: z.string().default("homerun"),
			socketPath: z.string().default(detectDockerSocketPath),
		})
		.prefault({}),
	logFormat: z.enum(["console", "json"]).default("console"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	// DB-only (the Pangolin card on /settings), mirrored here so the
	// forward-auth endpoint can read it per request without a query.
	pangolinEnabled: z.boolean().default(false),
	pangolinOwnsAuth: z.boolean().default(false),
	port: z.number().default(3000),
	serviceSubdomain: z.string().default(""),
	smtp: z
		.object({
			enabled: z.boolean().default(false),
			from: z.string().optional(),
			host: z.string().optional(),
			password: z.string().optional(),
			port: z.number().optional(),
			secure: z.boolean().optional(),
			user: z.string().optional(),
		})
		.prefault({}),
	traefik: z
		.object({
			acmeEmail: z.string().optional(),
			certResolver: z.string().default("letsencrypt"),
			dynamicConfigDir: z.string().optional(),
			entrypoint: z.string().default("websecure"),
			httpCache: z.boolean().default(false),
			instanceCertNames: z.array(z.string()).default([]),
		})
		.prefault({}),
	// The Go worker's Docker control API. The app makes no Docker calls of its
	// own any more : it asks the worker, which is the process that actually
	// holds the socket. Nothing here is optional in practice, an instance
	// without a reachable worker can't show a container's status at all.
	worker: z
		.object({
			token: z.string().default(""),
			url: z.string().default("http://localhost:7430"),
		})
		.prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;

/** The plain-value shape InstanceSettingsDTO.toConfigOverride() produces : kept here rather than imported from the DTO so this module stays DB-free (see applyInstanceSettings below). */
export interface InstanceSettingsOverride {
	authCheckUrl?: string | null;
	pangolinEnabled?: boolean | null;
	pangolinOwnsAuth?: boolean | null;
	serviceSubdomain?: string | null;
	authCrossSubdomainCookies?: boolean | null;
	authOrigin?: string | null;
	baseDomain?: string | null;
	dockerNetworkName?: string | null;
	dockerSocketPath?: string | null;
	oauthProviders?: AppConfig["auth"]["oauthProviders"];
	smtpEnabled?: boolean | null;
	smtpFrom?: string | null;
	smtpHost?: string | null;
	smtpPassword?: string | null;
	smtpPort?: number | null;
	smtpSecure?: boolean | null;
	smtpUser?: string | null;
	traefikAcmeEmail?: string | null;
	traefikCertResolver?: string | null;
	traefikDynamicConfigDir?: string | null;
	traefikEntrypoint?: string | null;
	traefikHttpCache?: boolean | null;
	traefikInstanceCertNames?: string[] | null;
}

/** Path to the YAML config file : `CONFIG_FILE` env var if set, else `./homerun.yaml` relative to cwd. This is the one env var config still needs, the same bootstrapping role `DATABASE_URL`/`AUTH_SECRET` already play. */
export function configFilePath(): string {
	return resolve(process.cwd(), Bun.env.CONFIG_FILE ?? "./homerun.yaml");
}

function readYamlConfig(): unknown {
	const path = configFilePath();
	if (!existsSync(path)) {
		return {};
	}
	const parsed = parseYaml(readFileSync(path, "utf-8"));
	return parsed ?? {};
}

/**
 * The first value that is set and not blank, so an env var left empty (as
 * `.env.example` ships `AUTH_SECRET=`) falls through to the next source or the
 * schema default instead of being used as-is.
 */
export function firstNonBlank(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value) => value !== undefined && value.trim() !== "");
}

/** Whether an auth secret is unusable : unset, blank, or the built-in `default-secret` placeholder the schema falls back to. */
export function isPlaceholderAuthSecret(secret: string | undefined): boolean {
	return firstNonBlank(secret) === undefined || secret === "default-secret";
}

/**
 * Builds the file+env configuration: validates the YAML config file, then layers
 * the env-only values (`DATABASE_URL`, `PORT`, `AUTH_SECRET`, `ORIGIN`,
 * `STORAGE_BASE_PATH`), the
 * `TRAEFIK_DYNAMIC_CONFIG_DIR` fallback for `traefik.dynamicConfigDir`, and the
 * default forwardAuth check URL over it.
 *
 * @throws When the config file fails schema validation, or the merged config
 * does (e.g. a missing auth secret or database URL).
 */
export const parseConfig = (): AppConfig => {
	const path = configFilePath();
	const yamlResult = yamlConfigSchema.safeParse(readYamlConfig());
	if (!yamlResult.success) {
		throw new Error(
			`Invalid config file ${path}:\n${z.prettifyError(yamlResult.error)}`,
		);
	}
	const yamlConfig = yamlResult.data;

	const port = Bun.env.PORT ? Number.parseInt(Bun.env.PORT, 10) : 3000;

	return configSchema.parse({
		...yamlConfig,
		auth: {
			...yamlConfig.auth,
			// ORIGIN is what compose.prod.yaml and the installer's generated
			// stack already set, and what better-auth's own docs call it :
			// honored as the env default for auth.origin so the per-app login
			// wall (docker/labels.ts's authRequired) knows where to send a
			// visitor without a second, separately-configured value.
			origin: firstNonBlank(yamlConfig.auth?.origin, Bun.env.ORIGIN),
			// AUTH_SECRET is the app-local var name ; BETTER_AUTH_SECRET is what
			// better-auth's own CLI (`auth generate`) and `.env` use by
			// convention, fall back to it so a generated secret is honored.
			secret: firstNonBlank(Bun.env.AUTH_SECRET, Bun.env.BETTER_AUTH_SECRET),
		},
		baseDomain: firstNonBlank(yamlConfig.baseDomain, Bun.env.BASE_DOMAIN),
		authCheckUrl:
			yamlConfig.authCheckUrl ??
			`http://host.docker.internal:${port}/api/v1/auth-check`,
		dataDir: firstNonBlank(Bun.env.STORAGE_BASE_PATH),
		databaseUrl: firstNonBlank(Bun.env.DATABASE_URL),
		port,
		traefik: {
			...yamlConfig.traefik,
			dynamicConfigDir: firstNonBlank(
				yamlConfig.traefik?.dynamicConfigDir,
				Bun.env.TRAEFIK_DYNAMIC_CONFIG_DIR,
			),
		},
		worker: {
			...yamlConfig.worker,
			// WORKER_TOKEN is the same value the worker itself reads, so one
			// variable configures both sides of the control API.
			token: firstNonBlank(
				yamlConfig.worker?.token,
				Bun.env.WORKER_TOKEN,
				deriveWorkerToken(
					firstNonBlank(Bun.env.AUTH_SECRET, Bun.env.BETTER_AUTH_SECRET) ??
						"default-secret",
				),
			),
			url: firstNonBlank(yamlConfig.worker?.url, Bun.env.WORKER_URL),
		},
	});
};

/**
 * A non-secret subset of the file defaults, safe to send to the client as
 * placeholder text on the /settings page ("blank = falls back to this").
 * Deliberately omits auth.secret and smtp.password : those never get
 * echoed back to the browser even as a default hint.
 */
export function envDefaultsForDisplay() {
	return {
		authCheckUrl: fileDefaults.authCheckUrl,
		authOrigin: fileDefaults.auth.origin ?? null,
		baseDomain: fileDefaults.baseDomain,
		dockerNetworkName: fileDefaults.docker.networkName,
		dockerSocketPath: fileDefaults.docker.socketPath,
		smtpEnabled: fileDefaults.smtp.enabled,
		smtpFrom: fileDefaults.smtp.from ?? null,
		smtpHost: fileDefaults.smtp.host ?? null,
		smtpPort: fileDefaults.smtp.port ?? null,
		smtpSecure: fileDefaults.smtp.secure ?? false,
		smtpUser: fileDefaults.smtp.user ?? null,
		traefikAcmeEmail: fileDefaults.traefik.acmeEmail ?? null,
		traefikCertResolver: fileDefaults.traefik.certResolver,
		traefikDynamicConfigDir: fileDefaults.traefik.dynamicConfigDir ?? null,
		traefikEntrypoint: fileDefaults.traefik.entrypoint,
	};
}

/**
 * Whether outgoing email can be sent: SMTP is enabled and host, port, user,
 * password and from address are all set. Logs a console warning when it's
 * enabled but incomplete.
 */
export function isSmtpEnabled(): boolean {
	const enabledInConfig = config.smtp?.enabled;
	const configuredProperly =
		config.smtp?.host &&
		config.smtp?.port &&
		config.smtp?.user &&
		config.smtp?.password &&
		config.smtp?.from;

	if (enabledInConfig && !configuredProperly) {
		// config.ts is a leaf module by design (see CLAUDE.md) : importing $lib/logger here would cycle, since Logger imports config.
		// oxlint-disable-next-line no-console -- no logger reachable from this module
		console.warn(
			"SMTP is enabled in configuration but missing required fields. Email verification will not work.",
		);
		return false;
	}

	return !!(enabledInConfig && configuredProperly);
}

// The file+env baseline : applyInstanceSettings() below always recomputes
// against this, never against the current `config`, so clearing a DB
// override reverts to this instead of going stale.
const fileDefaults = parseConfig();

// `config` is a stable object reference every other module imports and
// reads properties off live : mutated in place (never reassigned) so a
// settings change is visible everywhere without re-importing anything.
export const config: AppConfig = structuredClone(fileDefaults);

const authCheckUrlPinnedByFile = Boolean(
	yamlConfigSchema.safeParse(readYamlConfig()).data?.authCheckUrl,
);

/**
 * Replaces the default forwardAuth check URL with one detected at boot (the
 * dashboard's own container name on the Docker network), unless the config file
 * pins `authCheckUrl`. Takes effect on the next `applyInstanceSettings`.
 */
export function setDetectedAuthCheckUrl(url: string): void {
	if (authCheckUrlPinnedByFile) {
		return;
	}
	fileDefaults.authCheckUrl = url;
}

/**
 * Merges DB-backed instance settings (see InstanceSettingsDTO) over the
 * file+env defaults, in place. Called once at boot (hooks.server.ts's
 * init(), before the server accepts requests) and again after every
 * settings save so changes apply live : no process restart needed.
 * Deliberately doesn't import the DTO or the db itself: db/lib.ts imports
 * this module for `databaseUrl`, so this module must stay a leaf to avoid a
 * circular import.
 */
export function applyInstanceSettings(
	override: InstanceSettingsOverride = {},
): void {
	applyCoreOverride(override);
	applyAuthOverride(override);
	applyDockerOverride(override);
	applySmtpOverride(override);
	applyTraefikOverride(override);
}

/** Instance-wide addressing : the base domain, the forwardAuth check URL and the Pangolin flags. */
function applyCoreOverride(override: InstanceSettingsOverride): void {
	config.authCheckUrl = override.authCheckUrl ?? fileDefaults.authCheckUrl;
	config.pangolinEnabled = override.pangolinEnabled ?? false;
	config.pangolinOwnsAuth = override.pangolinOwnsAuth ?? false;
	const domain = override.baseDomain ?? fileDefaults.baseDomain;
	config.baseDomain = domain.split(":")[0] ?? domain;
	config.serviceSubdomain = override.serviceSubdomain ?? "";
}

/**
 * The domain services' default hostnames live under: the base domain, or
 * `<serviceSubdomain>.<baseDomain>` once the Services subdomain setting is
 * set, the way workstations get `<slug>.dev.<baseDomain>`.
 */
export function serviceDomain(): string {
	return config.serviceSubdomain
		? `${config.serviceSubdomain}.${config.baseDomain}`
		: config.baseDomain;
}

function applyAuthOverride(override: InstanceSettingsOverride): void {
	config.auth.crossSubdomainCookies =
		override.authCrossSubdomainCookies ??
		fileDefaults.auth.crossSubdomainCookies;
	config.auth.oauthProviders = override.oauthProviders ?? [];
	config.auth.origin = override.authOrigin ?? fileDefaults.auth.origin;
}

function applyDockerOverride(override: InstanceSettingsOverride): void {
	config.docker.networkName =
		override.dockerNetworkName ?? fileDefaults.docker.networkName;
	config.docker.socketPath =
		override.dockerSocketPath ?? fileDefaults.docker.socketPath;
}

function applySmtpOverride(override: InstanceSettingsOverride): void {
	config.smtp.enabled = override.smtpEnabled ?? fileDefaults.smtp.enabled;
	config.smtp.from = override.smtpFrom ?? fileDefaults.smtp.from;
	config.smtp.host = override.smtpHost ?? fileDefaults.smtp.host;
	config.smtp.password = override.smtpPassword ?? fileDefaults.smtp.password;
	config.smtp.port = override.smtpPort ?? fileDefaults.smtp.port;
	config.smtp.secure = override.smtpSecure ?? fileDefaults.smtp.secure;
	config.smtp.user = override.smtpUser ?? fileDefaults.smtp.user;
}

function applyTraefikOverride(override: InstanceSettingsOverride): void {
	config.traefik.acmeEmail =
		override.traefikAcmeEmail ?? fileDefaults.traefik.acmeEmail;
	config.traefik.certResolver =
		override.traefikCertResolver ?? fileDefaults.traefik.certResolver;
	config.traefik.dynamicConfigDir =
		override.traefikDynamicConfigDir ?? fileDefaults.traefik.dynamicConfigDir;
	config.traefik.entrypoint =
		override.traefikEntrypoint ?? fileDefaults.traefik.entrypoint;
	config.traefik.httpCache =
		override.traefikHttpCache ?? fileDefaults.traefik.httpCache;
	config.traefik.instanceCertNames = override.traefikInstanceCertNames ?? [];
}
