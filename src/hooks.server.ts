import { join } from "node:path";
import process, { cwd } from "node:process";
import type { RequestEvent } from "@sveltejs/kit";
import { type Handle, sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { applyInstanceSettings, config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDependencyDTO } from "#lib/dto/service-dependency-dto.js";
import { ERROR_PAGE_PATH } from "#lib/error-pages.js";
import { isIngestPath } from "#lib/error-tracking/envelope.js";
import { GIT_WEBHOOK_PATH } from "#lib/git-webhooks.js";
import { basicAuthPassword, IAC_API_PREFIX } from "#lib/iac-state.js";
import { Logger } from "#lib/logger.js";
import { OIDC_BASE_PATH, rebaseOnOrigin } from "#lib/oidc-provider.js";
import {
	APP_ONLY_MESSAGE,
	intersectPermissions,
	isAppOnly,
	parsePermissions,
	permissionsForRole,
} from "#lib/permissions.js";
import {
	appOnlyRejection,
	permissionRejection,
	serviceAccountRejection,
} from "#lib/server/access-gate.js";
import { clientAddress } from "#lib/server/client-address.js";
import { isForbiddenCrossSiteForm } from "#lib/server/csrf.js";
import { db as appDb, getDb, resetDb } from "#lib/server/db/index.js";
import { user as userTable } from "#lib/server/db/schema.js";
import { seedBuiltinTemplates } from "#lib/server/db/seed.js";
import {
	guardTokenRequest,
	OIDC_TOKEN_PATH,
	withTokenCors,
} from "#lib/server/oidc-client-guard.js";
import { AdminService } from "#lib/services/admin.service.js";
import { isBanned } from "#lib/services/app-access.service.js";
import {
	auth,
	pruneUndecryptableSigningKeys,
	rebuildAuth,
	verifyMcpAccessToken,
} from "#lib/services/auth.js";
import { detectAuthCheckUrl } from "#lib/services/cron/core-services-watch.js";
import { CronService } from "#lib/services/cron.service.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import { IpBanService } from "#lib/services/ip-ban.service.js";
import { OrchestrationService } from "#lib/services/orchestration.service.js";
import { JobWorker } from "#lib/services/queue/worker.js";
import { RedirectService } from "#lib/services/redirect.service.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { DEFAULT_SURFACE } from "#lib/surfaces.js";
import { isOtlpPath } from "#lib/tracing/otlp.js";
import {
	BANNED_ACCOUNT_MESSAGE,
	isServiceAccount,
	SERVICE_ACCOUNT_DISABLED_MESSAGE,
} from "#lib/user-types.js";
import { building } from "$app/env";

const ENDPOINT_ROUTE_IDS = new Set(
	Object.keys(import.meta.glob("./routes/**/+server.ts")).map((path) =>
		path.slice("./routes".length, -"/+server.ts".length),
	),
);

const logger = new Logger("Hooks");

const migrationsFolder = join(cwd(), "drizzle");

/**
 * A Postgres connection refused/timed out while a `load`/action reached the
 * DB : the common trigger is the app itself having started before Postgres
 * finished coming up (`docker compose up -d`, or a still-in-progress
 * migration retry loop, see `waitForDatabase`/`runMigrations` below, both
 * only gate this *server's* own boot, not a request that reaches it from a
 * separate, still-starting Postgres container in the same compose stack).
 * Distinguished so the error page says something actually actionable
 * ("still starting up, reload in a moment") instead of a raw driver
 * message like "connect ECONNREFUSED ...".
 */
function isDatabaseUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;

	return (
		code === "ECONNREFUSED" ||
		code === "ETIMEDOUT" ||
		/ECONNREFUSED|ETIMEDOUT/.test(error.message)
	);
}

/** Same short random-id convention as hooks.client.ts's makeid(), so a server-side 500 is just as traceable in the logs as a client-side one. */
function makeErrorId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/**
 * Logs an uncaught server error under a fresh error id and turns it into the
 * plain `App.Error` object the error page renders. Errors thrown with
 * `error()`, SvelteKit's own (404s) and validation errors keep their defaults,
 * and an unreachable database gets a `DATABASE_UNAVAILABLE` code with a
 * reload-in-a-moment message instead of the driver's.
 */
export function handleError({ event, error, kind }) {
	if (kind !== "unknown") {
		return;
	}
	const errorId = makeErrorId();
	logger.error(
		`Error on ${event.request.method} ${event.url.pathname} (errorId=${errorId})`,
		error,
	);

	// Real, tested-in-review bug this replaced : this used to `return new
	// Error(...)`, but this function's return value becomes `App.Error`
	// (app.d.ts), sent to the client as page data, and devalue (SvelteKit's
	// own load/error-payload serializer) can't stringify a real Error
	// instance, only a plain object. That crashed with a completely
	// unrelated-looking "Cannot stringify arbitrary non-POJOs" 500 instead
	// of the actual error, for *every* uncaught error in this app, not just
	// a DB-unavailable one, verified live.
	if (isDatabaseUnavailableError(error)) {
		return {
			code: "DATABASE_UNAVAILABLE",
			errorId,
			message:
				"The database isn't reachable yet, it may still be starting up. Wait a few seconds and reload.",
		};
	}

	return {
		errorId,
		message:
			error instanceof Error ? error.message : "An unknown error occurred.",
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks boot until Postgres answers a trivial query, retrying up to 10 times 2
 * seconds apart with a fresh connection pool each time, and exits the process
 * once retries run out.
 */
async function waitForDatabase() {
	const maxRetries = 10;
	const retryDelay = 2000;

	for (let i = 0; i < maxRetries; i += 1) {
		try {
			// Reset connection before each attempt to avoid stale connections
			if (i > 0) {
				// oxlint-disable-next-line no-await-in-loop -- retry backoff: each attempt must follow the previous one
				await resetDb();
			}
			// getDb() alone doesn't prove connectivity : drizzle-orm/bun-sql's
			// client is lazy (unlike bun:sqlite's `new Database(path)`, which
			// used to fail synchronously on an inaccessible path here). A
			// trivial real query is what actually verifies Postgres is up.
			const db = getDb();
			// oxlint-disable-next-line no-await-in-loop -- startup retries wait for Postgres one attempt at a time
			await db.execute("select 1");
			logger.info("Database connection established.");
			return;
		} catch (error) {
			if (i === maxRetries - 1) {
				logger.error(
					`Could not reach Postgres after ${maxRetries} attempts. Check DATABASE_URL in .env, and for local dev start it with "docker compose up -d". Exiting.`,
				);
				logger.error(`Last error: ${error}`);
				process.exit(1);
			}
			logger.info(`Waiting for database... (attempt ${i + 1}/${maxRetries})`);
			// oxlint-disable-next-line no-await-in-loop -- startup retries wait for Postgres one attempt at a time
			await sleep(retryDelay);
		}
	}
}

/**
 * Applies pending Drizzle migrations from `drizzle/`, retrying up to 10 times 3
 * seconds apart with a fresh connection pool, and exits the process if they
 * still fail.
 */
async function runMigrations() {
	logger.info("Migrating database...");
	let retries = 10;
	while (retries > 0) {
		try {
			logger.info(`Running migrations (retries left: ${retries})`);
			const db = getDb();
			// Real, tested-in-review finding: this was missing `await` : with
			// Postgres (real network I/O, unlike bun:sqlite's local-file
			// migrator which apparently never surfaced this), a rejected
			// migrate() became an *unhandled* promise rejection outside this
			// try/catch, which crashes the whole process instead of being
			// caught and retried below.
			// oxlint-disable-next-line no-await-in-loop -- retry loop: one migrate attempt at a time
			await migrate(db, {
				migrationsFolder,
			});
			logger.info("Database migrated successfully.");
			return;
		} catch (error) {
			logger.error(
				`Migration error, Retrying... (${retries} attempts left)`,
				error,
			);
			// This is the last retry, exit the process
			if (retries === 1) {
				logger.error("Could not migrate the database. Exiting.");
				logger.error(error);
				process.exit(1);
			}
			// Reset the database connection before retrying
			// oxlint-disable-next-line no-await-in-loop -- startup retries wait for Postgres one attempt at a time
			await resetDb();
			retries -= 1;
			// oxlint-disable-next-line no-await-in-loop -- startup retries wait for Postgres one attempt at a time
			await sleep(3000);
		}
	}
}

/** Once per instance, records the start-order dependencies of every service linked only through env vars, logging a summary and every skipped loop, then stamps it done so later boots skip it; never fails the boot. */
async function backfillDependencies(): Promise<void> {
	try {
		const settings = await InstanceSettingsDTO.get();
		if (settings.dependenciesBackfilled) {
			return;
		}
		const { added, cycles } = await ServiceDependencyDTO.backfillFromEnv();
		await settings.markDependenciesBackfilled();
		for (const cycle of cycles) {
			logger.warn(`Dependency backfill skipped ${cycle}: it would make a loop`);
		}
		if (added > 0 || cycles.length > 0) {
			logger.info(
				`Dependency backfill: recorded ${added} dependencies from env links, skipped ${cycles.length} loops`,
			);
		}
	} catch (err) {
		logger.warn("Couldn't backfill service dependencies from env links", err);
	}
}

/**
 * Server boot sequence, run once before the first request : waits for the
 * database, migrates and seeds built-in templates, applies DB-backed instance
 * settings (plus the auto-detected forward-auth URL when running in a
 * container), rebuilds auth, picks the orchestration mode for a brand new
 * instance and queues the redeploys `--migrate-to-rootful` asked for,
 * backfills start-order dependencies from pre-existing env links, then
 * starts the job worker, rollout health watches and every scheduler,
 * including the core-services watch that asserts the dashboard router, DNS,
 * Newt and swarm mode every time the worker (re)starts. With
 * `HOMERUN_CANDIDATE=1` (the self-updater's pre-switch check of a new
 * version) it stops after auth is built: the candidate only has to answer
 * `/api/v1/ready`, and must not run jobs or touch Traefik next to the live
 * app. Exits the process once adapter-bun has drained the server on SIGTERM,
 * since the job worker and schedulers would otherwise keep it alive.
 */
export const init = async () => {
	process.once("sveltekit:shutdown", () => process.exit(0));
	await waitForDatabase();
	await runMigrations();
	await seedBuiltinTemplates();

	// Merge DB-backed instance settings over the env defaults before the
	// server starts accepting requests : see $lib/config.ts. rebuildAuth()
	// reconstructs the better-auth singleton so OAuth providers configured
	// in the DB (rather than env) are present from the very first request,
	// not just after a settings-page save.
	const { created, settings } = await InstanceSettingsDTO.getOrCreate();
	applyInstanceSettings(settings.toConfigOverride());
	await detectAuthCheckUrl();
	rebuildAuth();
	await pruneUndecryptableSigningKeys().catch((err) => {
		logger.warn("Couldn't check the OIDC signing keys", err);
	});
	if (process.env.HOMERUN_CANDIDATE === "1") {
		logger.info(
			"Candidate mode: serving requests for the update check, no job worker, schedulers or core-services watch",
		);
		return;
	}
	await OrchestrationService.applyOnBoot(settings, created).catch((err) => {
		logger.warn("Couldn't apply the orchestration mode on boot", err);
	});
	await backfillDependencies();

	JobWorker.start();
	void DeploymentService.resumeHealthWatches();

	CronService.startCronScheduler();
	CronService.startBackupScheduler();
	CronService.startCronJobScheduler();
	CronService.startStatsSampler();
	CronService.startUptimeProbe();
	CronService.startMirrorGcScheduler();
	CronService.startUpdateCheckScheduler();
	CronService.startGitPollScheduler();
	CronService.startErrorRetention();
	CronService.startTraceRetention();
	CronService.startIpBanScheduler();
	CronService.startBackupCapacityScheduler();
	CronService.startCoreServicesWatch();
	CronService.startSwarmDnsWatch();
	CronService.startWorkstationAutoStop();
	void RedirectService.sync();
	void IpBanService.sync();
};

/**
 * Paths under the auth basePath that are handled by SvelteKit, not
 * better-auth. Real, tested-live finding: `/api/v1/auth/cli/device` and
 * `/api/v1/auth/cli/token` (the CLI's `homerun login` device-code flow,
 * $lib/services/cli-auth.service.ts) were never added here, so every
 * request to either one was silently swallowed by better-auth's own
 * handler (any path starting with the auth basePath goes to
 * `auth.handler()` unless it's in this set, see svelteKitHandler's
 * `isAuthPath` in node_modules/better-auth/dist/integrations/svelte-kit.mjs)
 * and 404'd before ever reaching the real SvelteKit route files — verified
 * live, a real `homerun login` against a real running instance failed
 * immediately with "Couldn't start login: 404 Not Found" before this fix.
 */
const customAuthPaths = new Set([
	"/api/v1/auth/providers",
	"/api/v1/auth/cli/device",
	"/api/v1/auth/cli/token",
]);

/**
 * better-auth's real email/password sign-up endpoint (confirmed against
 * node_modules/better-auth/dist/api/routes/sign-up.mjs : `/sign-up/email`
 * relative to the basePath). Blocked directly here, not just hidden in the
 * UI, once any account exists : every account after the first is created
 * by an admin from the Users page (direct-create or email invite), never
 * through public self-service sign-up again.
 */
const SIGN_UP_PATH = "/api/v1/auth/sign-up/email";

/** Blocks public self-service sign-up once any account exists : the endpoint itself, so it can't be curled around. */
async function signUpClosedResponse(
	event: RequestEvent,
): Promise<Response | null> {
	const isSignUp =
		event.request.method === "POST" && event.url.pathname === SIGN_UP_PATH;

	if (!(isSignUp && (await AdminService.hasAnyUser()))) {
		return null;
	}
	return new Response(
		JSON.stringify({
			message: "Sign-up is closed : an admin account already exists.",
		}),
		{ headers: { "content-type": "application/json" }, status: 403 },
	);
}

/** The raw API key from `x-api-key`, `Authorization: Bearer`, or Basic auth's password on the Terraform state routes (the only credentials Terraform's http backend can send), or null when none is present. */
function readApiKey(event: RequestEvent): string | null {
	const authHeader = event.request.headers.get("authorization");

	return (
		event.request.headers.get("x-api-key") ??
		(authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null) ??
		(event.url.pathname.startsWith(IAC_API_PREFIX)
			? basicAuthPassword(authHeader)
			: null)
	);
}

/**
 * Whether `pathname` is one of the OAuth/OIDC provider endpoints apps call
 * with their own `Authorization: Bearer <access token>` (userinfo,
 * introspection, revocation) or read anonymously (JWKS, discovery). Those
 * tokens aren't Homerun API keys, so the API-key fallback must not 401 them.
 */
function isOidcProviderPath(pathname: string): boolean {
	return (
		pathname.startsWith(`${OIDC_BASE_PATH}/oauth2/`) ||
		pathname.startsWith(`${OIDC_BASE_PATH}/.well-known/`) ||
		pathname === `${OIDC_BASE_PATH}/jwks`
	);
}

/**
 * Whether this is the login wall's forwardAuth check, or one of the error
 * pages Traefik fetches for anonymous visitors on every host. It skips the session
 * and API-key lookups entirely: the check reads its own gate cookie, never
 * `locals.user`; an `Authorization: Bearer` there is the gated app's own token
 * (Umami's API calls carry one), not a Homerun API key; and every routed
 * service calls it on every request, so an auth layer that fails to build
 * (a bad dashboard URL did) must not take every site down with the dashboard.
 */
function isAuthCheckPath(url: URL): boolean {
	return (
		url.pathname === "/api/v1/auth-check" ||
		url.pathname.startsWith(`${ERROR_PAGE_PATH}/`)
	);
}

/** Whether a bearer credential is a JWT rather than an opaque API key. */
function isJwt(token: string): boolean {
	return token.split(".").length === 3;
}

/**
 * Signs the request in with an OAuth access token an MCP client (claude.ai,
 * Claude Code…) got from Homerun: a JWT signed with Homerun's own keys whose
 * audience is the MCP endpoint, so an id token or a token minted for an app
 * using "Sign in with Homerun" is refused. Returns a 401 when it doesn't
 * verify, and a 403 when its owner is app-access-only or banned.
 */
async function applyMcpTokenAuth(
	event: RequestEvent,
	token: string,
): Promise<Response | null> {
	const userId = await verifyMcpAccessToken(token);
	if (!userId) {
		logger.warn("Invalid MCP access token");
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
		});
	}
	const [tokenUser] = await appDb
		.select()
		.from(userTable)
		.where(eq(userTable.id, userId))
		.limit(1);
	if (tokenUser && isAppOnly(tokenUser.role)) {
		return appOnlyTokenRefusal();
	}
	if (tokenUser && isBanned(tokenUser)) {
		return bannedTokenRefusal();
	}
	if (tokenUser) {
		event.locals.user = tokenUser;
	}
	return null;
}

/** The 403 for an API key or MCP token owned by a banned user, until the ban expires or is lifted. */
function bannedTokenRefusal(): Response {
	return Response.json({ error: BANNED_ACCOUNT_MESSAGE }, { status: 403 });
}

/** The 403 for an API key or MCP token owned by an app-access-only user, who can't use either. */
function appOnlyTokenRefusal(): Response {
	return new Response(JSON.stringify({ error: APP_ONLY_MESSAGE }), {
		headers: { "content-type": "application/json" },
		status: 403,
	});
}

/**
 * How long until a rate-limited API key may be used again (in ms), when
 * `refusal` is better-auth's rate-limit refusal, else null. `verifyApiKey`
 * returns it as `{ valid: false, error }` rather than throwing, but a thrown
 * `APIError` carries the same shape in its `body`.
 */
function rateLimitedFor(
	refusal: { code?: string; details?: { tryAgainIn?: number } } | undefined,
): number | null {
	return refusal?.code === "RATE_LIMITED"
		? (refusal.details?.tryAgainIn ?? 60_000)
		: null;
}

/**
 * API-key fallback for a request with no cookie session : populates
 * `locals.user` on success, and returns a 401 response when a key was sent
 * but doesn't verify, a 429 with `Retry-After` when it's rate-limited, and a
 * 403 when its owner is app-access-only or banned (a ban past its expiry no
 * longer counts). Returns null when there's nothing to do.
 */
async function applyApiKeyAuth(event: RequestEvent): Promise<Response | null> {
	const rawKey = readApiKey(event);
	if (!rawKey) {
		return null;
	}

	if (isJwt(rawKey)) {
		return await applyMcpTokenAuth(event, rawKey);
	}

	let tryAgainInMs: number | null = null;
	const result = await auth.api
		.verifyApiKey({ body: { key: rawKey } })
		.catch((err: unknown) => {
			tryAgainInMs = rateLimitedFor(
				(err as { body?: Parameters<typeof rateLimitedFor>[0] })?.body,
			);
			return null;
		});
	tryAgainInMs ??= rateLimitedFor(
		(result as { error?: Parameters<typeof rateLimitedFor>[0] } | null)?.error,
	);
	if (tryAgainInMs !== null) {
		return new Response(
			JSON.stringify({ error: "Too many requests with this API key." }),
			{
				headers: {
					"Retry-After": String(Math.max(1, Math.ceil(tryAgainInMs / 1000))),
				},
				status: 429,
			},
		);
	}

	if (!(result?.valid && result.key)) {
		logger.warn("Invalid API key authentication attempt", {
			key: `${rawKey.slice(0, 6)}…`,
		});
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
		});
	}

	// Look the owning user up directly by the key's referenceId rather
	// than going through getSession's API-key session-mocking (that
	// path is gated behind enableSessionForAPIKeys, which better-auth's
	// own docs warn against enabling in production : see api-key
	// plugin's types.d.ts).
	const [apiKeyUser] = await appDb
		.select()
		.from(userTable)
		.where(eq(userTable.id, result.key.referenceId))
		.limit(1);

	if (apiKeyUser && isAppOnly(apiKeyUser.role)) {
		return appOnlyTokenRefusal();
	}
	if (apiKeyUser && isBanned(apiKeyUser)) {
		if (!isServiceAccount(apiKeyUser)) {
			return bannedTokenRefusal();
		}
		await ServiceAccountService.recordUse(apiKeyUser, {
			action: "api.request",
			detail: `${event.request.method} ${event.url.pathname}: refused, account disabled`,
			ipAddress: clientAddress(event),
			status: 403,
		});
		return Response.json(
			{ error: SERVICE_ACCOUNT_DISABLED_MESSAGE },
			{ status: 403 },
		);
	}
	if (apiKeyUser) {
		event.locals.user = apiKeyUser;
		const ownerPermissions = permissionsForRole(
			apiKeyUser.role,
			apiKeyUser.permissions,
		);
		event.locals.permissions = result.key.permissions
			? intersectPermissions(
					ownerPermissions,
					parsePermissions(result.key.permissions),
				)
			: ownerPermissions;
	}
	return null;
}

/**
 * Resolves the request's user from the better-auth session cookie, falling back
 * to an API key, and sets `locals.permissions`. Rejects closed sign-up and bad API
 * keys up front, and passes auth API paths to better-auth except the few
 * SvelteKit routes that live under its base path.
 */
const authHandler: Handle = async ({ event, resolve }) => {
	if (
		isAuthCheckPath(event.url) ||
		isIngestPath(event.url.pathname) ||
		isOtlpPath(event.url.pathname)
	) {
		event.locals.permissions = {};
		event.locals.appOnly = false;
		return resolve(event);
	}

	const signUpClosed = await signUpClosedResponse(event);
	if (signUpClosed) {
		return signUpClosed;
	}

	const session = await auth.api
		.getSession({ headers: event.request.headers })
		.catch((error) => {
			logger.debug("auth.getSession() failed : treating as signed out", error);
			return null;
		});

	if (session) {
		// Make session and user available on server
		event.locals.session = session.session;
		event.locals.user = session.user;
	} else if (!isOidcProviderPath(event.url.pathname)) {
		const rejected = await applyApiKeyAuth(event);
		if (rejected) {
			return rejected;
		}
	}

	event.locals.permissions ??= event.locals.user
		? permissionsForRole(event.locals.user.role, event.locals.user.permissions)
		: {};
	event.locals.appOnly = isAppOnly(event.locals.user?.role);
	if (isServiceAccount(event.locals.user)) {
		const refused = serviceAccountRejection(
			event.request,
			event.url.pathname,
			event.route.id,
			event.locals.permissions,
		);
		if (refused) {
			return refused;
		}
	}
	if (event.locals.appOnly) {
		const refused = appOnlyRejection(
			event.request,
			event.url.pathname,
			event.route.id,
			event.isDataRequest,
		);
		if (refused) {
			return refused;
		}
	}
	if (event.locals.user) {
		const refused = permissionRejection(
			event.request,
			event.url.pathname,
			{
				id: event.route.id,
				isEndpoint: ENDPOINT_ROUTE_IDS.has(event.route.id ?? ""),
			},
			event.locals.permissions,
		);
		if (refused) {
			return refused;
		}
	}

	// Skip better-auth handler for custom SvelteKit-managed auth routes
	if (customAuthPaths.has(event.url.pathname)) {
		return resolve(event);
	}

	if (
		!building &&
		config.auth.origin &&
		isOidcProviderPath(event.url.pathname)
	) {
		if (event.url.pathname === OIDC_TOKEN_PATH) {
			const refused = await guardTokenRequest(event.request);
			if (refused) {
				return refused;
			}
			return await withTokenCors(
				event.request,
				await auth.handler(rebaseOnOrigin(event.request, config.auth.origin)),
			);
		}
		return auth.handler(rebaseOnOrigin(event.request, config.auth.origin));
	}

	return svelteKitHandler({ auth, building, event, resolve });
};

/**
 * Resolves the request with only content-length and content-type exposed to
 * serialized fetches, then logs it : an error line for 4xx/5xx page responses
 * other than 404, an info line otherwise. Well-known paths and the favicon skip
 * logging.
 */
const generalHandler: Handle = async ({ event, resolve }) => {
	const isUpload =
		event.request.method === "POST" &&
		event.url.pathname.includes("/storage/objects/item/");

	if (event.url.pathname.startsWith("/.well-known/")) {
		return await resolve(event);
	}
	// Ignore errors for favicon.ico
	if (event.url.pathname === "/favicon.ico") {
		return await resolve(event);
	}

	if (isUpload) {
		logger.debug("HOOKS_GENERAL", "About to resolve for upload", {
			bodyUsed: event.request.bodyUsed,
		});
	}

	const res = await resolve(event, {
		filterSerializedResponseHeaders(name) {
			return name === "content-length" || name === "content-type";
		},
		transformPageChunk: ({ html }) =>
			html.replace(
				"%homerun.surface%",
				event.locals.surface ?? DEFAULT_SURFACE,
			),
	});

	if (isUpload) {
		logger.debug("HOOKS_GENERAL", "resolve complete for upload", {
			bodyUsed: event.request.bodyUsed,
			status: res.status,
		});
	}

	const isAsset =
		!event.url.pathname.endsWith("/") && event.url.pathname.includes(".");
	if (
		res.status >= 400 &&
		!isAsset &&
		res.status !== 404 &&
		!isIngestPath(event.url.pathname)
	) {
		logger.error(
			`Error on ${event.request.method} ${event.url.pathname} - ${res.status}`,
		);
	} else {
		logger.info(
			`${event.request.method} ${event.url.pathname} - ${res.status}`,
		);
	}
	return res;
};

const OIDC_SERVER_TO_SERVER_PATHS = new Set(
	["token", "introspect", "revoke", "end-session"].map(
		(endpoint) => `${OIDC_BASE_PATH}/oauth2/${endpoint}`,
	),
);

/**
 * Refuses cross-site form posts, in place of SvelteKit's built-in check
 * (turned off in vite.config.ts), except on the OAuth endpoints apps call
 * from their own servers, on git push webhooks, which arrive with a form
 * body (depending on the provider) and no `Origin` header, and on the error
 * pages, where Traefik sends scanners' form posts to blocked paths.
 */
const csrfHandler: Handle = async ({ event, resolve }) => {
	if (
		!building &&
		isForbiddenCrossSiteForm(
			event.request,
			event.url,
			(pathname) =>
				OIDC_SERVER_TO_SERVER_PATHS.has(pathname) ||
				pathname.startsWith(`${GIT_WEBHOOK_PATH}/`) ||
				pathname.startsWith(`${ERROR_PAGE_PATH}/`) ||
				isIngestPath(pathname) ||
				isOtlpPath(pathname),
		)
	) {
		return new Response(
			`Cross-site ${event.request.method} form submissions are forbidden`,
			{ status: 403 },
		);
	}
	return await resolve(event);
};

/**
 * Writes every request made with a service account's API key to the audit
 * log, with its outcome. `/app-auth` is left to the page itself, which logs
 * the handshake with the app it was for.
 */
const serviceAccountAuditHandler: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const account = event.locals.user;
	if (isServiceAccount(account) && event.route.id !== "/app-auth") {
		await ServiceAccountService.recordUse(account, {
			action: "api.request",
			detail: `${event.request.method} ${event.url.pathname}`,
			ipAddress: clientAddress(event),
			status: response.status,
		});
	}
	return response;
};

export const handle = sequence(
	csrfHandler,
	generalHandler,
	serviceAccountAuditHandler,
	authHandler,
);
