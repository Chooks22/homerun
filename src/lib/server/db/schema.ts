import { relations, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { DestinationType } from "#lib/backup-destinations.js";
import type { BuildMethod } from "#lib/build-methods.js";
import type {
	CronJobFile,
	CronJobKind,
	CronJobMount,
	CronJobRunTrigger,
	ScriptRuntime,
} from "#lib/cron-job-script.js";
import type { DeployTrigger } from "#lib/deploy-trigger.js";
import type { ErrorPagesSettings } from "#lib/error-pages.js";
import type { StoredErrorEvent } from "#lib/error-tracking/event.js";
import type { IacTool } from "#lib/iac/tools.js";
import type {
	BlockSeverity,
	ImageScanFinding,
	ImageScanStatus,
	SeverityCounts,
} from "#lib/image-scan.js";
import type { IpBanSettings } from "#lib/ip-bans.js";
import type { ObjectStoreKind } from "#lib/object-storage.js";
import type { AuthPathsMode } from "#lib/path-patterns.js";
import type { Permissions, Role } from "#lib/permissions.js";
import type { PublishedPort } from "#lib/published-ports.js";
import type { ResourceKind, Threshold } from "#lib/resource-thresholds.js";
import type { BackupRunKind, RevisionConfig } from "#lib/revision-config.js";
import type { Preset, SurfaceStyle } from "#lib/surfaces.js";
import type { TabLayout } from "#lib/tab-layout.js";
import type {
	ContainerStatus,
	JobStage,
	JobStatus,
	JobType,
	NotificationChannelKind,
	NotificationEvent,
	PullPolicy,
	RevisionHealth,
	StatusPageScope,
} from "#lib/types.js";
import type { UiMode } from "#lib/ui-mode.js";

export const user = pgTable("user", {
	banExpires: timestamp("ban_expires", { mode: "date" }),
	banned: boolean("banned").default(false),
	banReason: text("ban_reason"),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	id: text("id").primaryKey(),
	image: text("image"),
	lastSignInAt: timestamp("last_sign_in_at", { mode: "date" }),
	name: text("name").notNull(),
	permissions: jsonb("permissions").$type<Permissions>(),
	role: text("role"),
	twoFactorEnabled: boolean("two_factor_enabled").default(false),
	updatedAt: timestamp("updated_at", { mode: "date" })
		.$onUpdate(() => new Date())
		.notNull(),
});

export const session = pgTable(
	"session",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		impersonatedBy: text("impersonated_by"),
		ipAddress: text("ip_address"),
		token: text("token").notNull().unique(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		accessToken: text("access_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			mode: "date",
		}),
		accountId: text("account_id").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		idToken: text("id_token"),
		password: text("password"),
		providerId: text("provider_id").notNull(),
		refreshToken: text("refresh_token"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			mode: "date",
		}),
		scope: text("scope"),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("account_providerId_accountId_uidx").on(
			table.providerId,
			table.accountId,
		),
		index("account_userId_idx").on(table.userId),
	],
);

export const verification = pgTable(
	"verification",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		value: text("value").notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const apikey = pgTable(
	"apikey",
	{
		configId: text("config_id").default("default").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		enabled: boolean("enabled").default(true),
		expiresAt: timestamp("expires_at", { mode: "date" }),
		id: text("id").primaryKey(),
		key: text("key").notNull(),
		lastRefillAt: timestamp("last_refill_at", { mode: "date" }),
		lastRequest: timestamp("last_request", { mode: "date" }),
		metadata: text("metadata"),
		name: text("name"),
		permissions: text("permissions"),
		prefix: text("prefix"),
		rateLimitEnabled: boolean("rate_limit_enabled").default(true),
		rateLimitMax: integer("rate_limit_max").default(10),
		rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
		referenceId: text("reference_id").notNull(),
		refillAmount: integer("refill_amount"),
		refillInterval: integer("refill_interval"),
		remaining: integer("remaining"),
		requestCount: integer("request_count").default(0),
		start: text("start"),
		updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
	},
	(table) => [
		index("apikey_configId_idx").on(table.configId),
		index("apikey_referenceId_idx").on(table.referenceId),
		index("apikey_key_idx").on(table.key),
	],
);

export const passkey = pgTable(
	"passkey",
	{
		aaguid: text("aaguid"),
		backedUp: boolean("backed_up").notNull(),
		counter: integer("counter").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }),
		credentialID: text("credential_id").notNull(),
		deviceType: text("device_type").notNull(),
		id: text("id").primaryKey(),
		name: text("name"),
		publicKey: text("public_key").notNull(),
		transports: text("transports"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("passkey_userId_idx").on(table.userId),
		index("passkey_credentialID_idx").on(table.credentialID),
	],
);

export const twoFactor = pgTable(
	"two_factor",
	{
		backupCodes: text("backup_codes").notNull(),
		failedVerificationCount: integer("failed_verification_count").default(0),
		id: text("id").primaryKey(),
		lockedUntil: timestamp("locked_until", { mode: "date" }),
		secret: text("secret").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		verified: boolean("verified").default(true),
	},
	(table) => [
		index("twoFactor_secret_idx").on(table.secret),
		index("twoFactor_userId_idx").on(table.userId),
	],
);

export const jwks = pgTable("jwks", {
	alg: text("alg"),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	crv: text("crv"),
	expiresAt: timestamp("expires_at", { mode: "date" }),
	id: text("id").primaryKey(),
	privateKey: text("private_key").notNull(),
	publicKey: text("public_key").notNull(),
});

export const oauthClient = pgTable(
	"oauth_client",
	{
		applicationType: text("application_type"),
		backchannelLogoutSessionRequired: boolean(
			"backchannel_logout_session_required",
		),
		backchannelLogoutUri: text("backchannel_logout_uri"),
		clientCredentialsScopes: text("client_credentials_scopes").default("[]"),
		clientDiscoveryId: text("client_discovery_id"),
		clientId: text("client_id").notNull().unique(),
		clientSecret: text("client_secret"),
		contacts: text("contacts"),
		createdAt: timestamp("created_at", { mode: "date" }),
		disabled: boolean("disabled").default(false),
		dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
		enableEndSession: boolean("enable_end_session"),
		grantTypes: text("grant_types"),
		icon: text("icon"),
		id: text("id").primaryKey(),
		jwks: text("jwks"),
		jwksUri: text("jwks_uri"),
		metadata: text("metadata"),
		name: text("name"),
		policy: text("policy"),
		postLogoutRedirectUris: text("post_logout_redirect_uris"),
		redirectUris: text("redirect_uris").notNull(),
		referenceId: text("reference_id"),
		requirePKCE: boolean("require_pkce"),
		responseTypes: text("response_types"),
		scopes: text("scopes"),
		skipConsent: boolean("skip_consent"),
		softwareId: text("software_id"),
		softwareStatement: text("software_statement"),
		softwareVersion: text("software_version"),
		subjectType: text("subject_type"),
		tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
		tos: text("tos"),
		updatedAt: timestamp("updated_at", { mode: "date" }),
		uri: text("uri"),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("oauthClient_userId_idx").on(table.userId)],
);

export const oauthClientEnvironment = pgTable(
	"oauth_client_environment",
	{
		allowedOrigins: jsonb("allowed_origins")
			.$type<string[]>()
			.default([])
			.notNull(),
		allowLocalhost: boolean("allow_localhost").default(false).notNull(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		redirectUris: jsonb("redirect_uris")
			.$type<string[]>()
			.default([])
			.notNull(),
	},
	(table) => [
		uniqueIndex("oauthClientEnvironment_clientId_name_uidx").on(
			table.clientId,
			table.name,
		),
	],
);

export const oauthClientSecret = pgTable(
	"oauth_client_secret",
	{
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		environmentId: text("environment_id").references(
			() => oauthClientEnvironment.id,
			{ onDelete: "cascade" },
		),
		expiresAt: timestamp("expires_at", { mode: "date" }),
		hint: text("hint").notNull(),
		id: text("id").primaryKey(),
		label: text("label").notNull(),
		lastUsedAt: timestamp("last_used_at", { mode: "date" }),
		secretHash: text("secret_hash").notNull().unique(),
	},
	(table) => [index("oauthClientSecret_clientId_idx").on(table.clientId)],
);

export const oauthResource = pgTable("oauth_resource", {
	accessTokenTtl: integer("access_token_ttl"),
	allowedScopes: text("allowed_scopes"),
	createdAt: timestamp("created_at", { mode: "date" }),
	customClaims: text("custom_claims"),
	disabled: boolean("disabled").default(false),
	dpopBoundAccessTokensRequired: boolean(
		"dpop_bound_access_tokens_required",
	).default(false),
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull().unique(),
	metadata: text("metadata"),
	name: text("name").notNull(),
	policyVersion: integer("policy_version").default(1),
	refreshTokenTtl: integer("refresh_token_ttl"),
	signingAlgorithm: text("signing_algorithm"),
	signingKeyId: text("signing_key_id"),
	updatedAt: timestamp("updated_at", { mode: "date" }),
});

export const oauthClientResource = pgTable(
	"oauth_client_resource",
	{
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { mode: "date" }),
		id: text("id").primaryKey(),
		metadata: text("metadata"),
		resourceId: text("resource_id")
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: "cascade" }),
	},
	(table) => [
		index("oauthClientResource_clientId_idx").on(table.clientId),
		index("oauthClientResource_resourceId_idx").on(table.resourceId),
		uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(
			table.clientId,
			table.resourceId,
		),
	],
);

export const oauthRefreshToken = pgTable(
	"oauth_refresh_token",
	{
		authTime: timestamp("auth_time", { mode: "date" }),
		authorizationCodeId: text("authorization_code_id"),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		confirmation: text("confirmation"),
		createdAt: timestamp("created_at", { mode: "date" }),
		expiresAt: timestamp("expires_at", { mode: "date" }),
		id: text("id").primaryKey(),
		referenceId: text("reference_id"),
		requestedUserInfoClaims: text("requested_user_info_claims"),
		resources: text("resources"),
		revoked: timestamp("revoked", { mode: "date" }),
		rotatedAt: timestamp("rotated_at", { mode: "date" }),
		rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", {
			mode: "date",
		}),
		rotationReplayResponse: text("rotation_replay_response"),
		scopes: text("scopes").notNull(),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		token: text("token").notNull().unique(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("oauthRefreshToken_clientId_idx").on(table.clientId),
		index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
		index("oauthRefreshToken_userId_idx").on(table.userId),
		index("oauthRefreshToken_authorizationCodeId_idx").on(
			table.authorizationCodeId,
		),
	],
);

export const oauthAccessToken = pgTable(
	"oauth_access_token",
	{
		authorizationCodeId: text("authorization_code_id"),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		confirmation: text("confirmation"),
		createdAt: timestamp("created_at", { mode: "date" }),
		expiresAt: timestamp("expires_at", { mode: "date" }),
		id: text("id").primaryKey(),
		referenceId: text("reference_id"),
		refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
			onDelete: "set null",
		}),
		requestedUserInfoClaims: text("requested_user_info_claims"),
		resources: text("resources"),
		revoked: timestamp("revoked", { mode: "date" }),
		scopes: text("scopes").notNull(),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		token: text("token").unique(),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("oauthAccessToken_clientId_idx").on(table.clientId),
		index("oauthAccessToken_sessionId_idx").on(table.sessionId),
		index("oauthAccessToken_userId_idx").on(table.userId),
		index("oauthAccessToken_authorizationCodeId_idx").on(
			table.authorizationCodeId,
		),
		index("oauthAccessToken_refreshId_idx").on(table.refreshId),
	],
);

export const oauthConsent = pgTable(
	"oauth_consent",
	{
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { mode: "date" }),
		id: text("id").primaryKey(),
		referenceId: text("reference_id"),
		requestedUserInfoClaims: text("requested_user_info_claims"),
		resources: text("resources"),
		scopes: text("scopes").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("oauthConsent_clientId_idx").on(table.clientId),
		index("oauthConsent_userId_idx").on(table.userId),
	],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
	expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
	id: text("id").primaryKey(),
});

// ─── PaaS Domain ────────────────────────────────────────────────────────────

export const stack = pgTable(
	"stack",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		description: text("description"),
		icon: text("icon"),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		parentId: text("parent_id").references((): AnyPgColumn => stack.id, {
			onDelete: "set null",
		}),
		// DNS-safe prefix applied to every member service's container name and
		// subdomain (e.g. "<stackSlug>-<serviceSlug>.<baseDomain>") : see
		// docker/service.ts's containerName() and docker/labels.ts.
		slug: text("slug").notNull().unique(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("stack_userId_idx").on(table.userId)],
);

export const remoteHost = pgTable(
	"remote_host",
	{
		// AES-256-GCM ciphertext, same scheme as service.registryPasswordEnc :
		// only set when kind = "agent". The bearer token this app presents to
		// the remote Homerun Agent's HTTP API (see agent/README.md).
		agentTokenEnc: text("agent_token_enc"),
		// "http://host:7420" or "https://host:7420", the Homerun Agent's own
		// reachable base URL : only set when kind = "agent". Distinct from
		// dockerHost, which speaks the raw Docker Engine API directly instead
		// of going through an agent's HTTP surface.
		agentUrl: text("agent_url"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		// "tcp://host:2376" (optionally TLS-secured with the ca/cert/key
		// below) or "ssh://user@host" : handed to the worker's remote client
		// as-is, parsed by the worker's remote-daemon client. Never a bare
		// "unix://..." : the local socket is always the implicit default
		// for deploys, not a row in this table. Only
		// set when kind = "docker".
		dockerHost: text("docker_host"),
		id: text("id").primaryKey(),
		// "docker" (the original/default, a raw tcp://ssh:// Docker Engine
		// connection) or "agent" (a registered Homerun Agent, see agent/README.md
		// : token-authenticated HTTP instead of a raw Docker socket/TLS cert).
		// Both kinds are real build servers : RemoteHostDTO.resolveBuildTarget
		// resolves either one into a `RemoteExecutionTarget`, which
		// deploy.service.ts branches on to route a git build through
		// DockerService (docker) or AgentClientService (agent).
		kind: text("kind", { enum: ["docker", "agent"] })
			.default("docker")
			.notNull(),
		name: text("name").notNull(),
		// AES-256-GCM ciphertext, same scheme as service.registryPasswordEnc
		// : only set when dockerHost uses TLS-secured tcp://.
		sshHost: text("ssh_host"),
		sshPort: integer("ssh_port"),
		sshUser: text("ssh_user"),
		sshHostKey: text("ssh_host_key"),
		tlsCaEnc: text("tls_ca_enc"),
		tlsCertEnc: text("tls_cert_enc"),
		tlsKeyEnc: text("tls_key_enc"),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("remoteHost_userId_idx").on(table.userId)],
);

export const workstation = pgTable(
	"workstation",
	{
		autoStopAt: timestamp("auto_stop_at", { mode: "date" }),
		autoStopMinutes: integer("auto_stop_minutes"),
		autoStopMode: text("auto_stop_mode", { enum: ["idle", "timer"] }),
		cpuLimit: doublePrecision("cpu_limit"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		desiredState: text("desired_state", { enum: ["running", "stopped"] })
			.default("stopped")
			.notNull(),
		env: jsonb("env").$type<Record<string, string>>().default({}).notNull(),
		gitBranch: text("git_branch"),
		gitUrl: text("git_url"),
		homePath: text("home_path").default("/home/coder").notNull(),
		id: text("id").primaryKey(),
		image: text("image").default("codercom/code-server:latest").notNull(),
		lastError: text("last_error"),
		memoryLimitMb: integer("memory_limit_mb"),
		name: text("name").notNull(),
		passwordEnc: text("password_enc").notNull(),
		port: integer("port").default(8080).notNull(),
		remoteHostId: text("remote_host_id").references(() => remoteHost.id, {
			onDelete: "cascade",
		}),
		slug: text("slug").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("workstation_slug_idx").on(table.slug),
		index("workstation_userId_idx").on(table.userId),
	],
);

export const ipBan = pgTable("ip_ban", {
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	expiresAt: timestamp("expires_at", { mode: "date" }),
	host: text("host"),
	ip: text("ip").primaryKey(),
	reason: text("reason").notNull(),
});

export const blockedHit = pgTable(
	"blocked_hit",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		host: text("host"),
		id: serial("id").primaryKey(),
		ip: text("ip").notNull(),
		path: text("path"),
	},
	(table) => [
		index("blockedHit_ip_createdAt_idx").on(table.ip, table.createdAt),
	],
);

export const redirect = pgTable(
	"redirect",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		destination: text("destination").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		id: text("id").primaryKey(),
		keepPath: boolean("keep_path").notNull().default(true),
		permanent: boolean("permanent").notNull().default(true),
		source: text("source").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("redirect_source_idx").on(table.source),
		index("redirect_userId_idx").on(table.userId),
	],
);

// A named Docker registry used as a *build cache* for git-based builds (see
// internal/agent/build.go), not a deploy target : the build pulls
// `<registryUrl>/<cacheRepository>:cache-<slug>` as a `--cache-from` source
// before building and pushes the fresh layers back after, so a repeat build
// of the same service reuses unchanged layers instead of rebuilding from
// scratch. Picked per-service on the Source tab (git mode only), same
// "reusable named profile, not duplicated per-service creds" shape as
// s3Destination.
export const buildCacheRegistry = pgTable(
	"build_cache_registry",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		// AES-256-GCM ciphertext, same scheme as service.registryPasswordEnc.
		passwordEnc: text("password_enc").notNull(),
		// "registry.example.com" or "ghcr.io" : no scheme, matches how
		// the Engine's authconfig.serveraddress and image ref prefixes are
		// both written.
		registryUrl: text("registry_url").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		username: text("username").notNull(),
	},
	(table) => [index("buildCacheRegistry_userId_idx").on(table.userId)],
);

// Push/pull credentials for the built-in registry (the `homerun-mirror`
// container, see services/docker/image-scan-refs.ts). Each row becomes one
// bcrypt line in the registry's htpasswd file, which is the only auth
// mechanism registry:2 supports without a separate token server : every
// token can both push and pull, and revoking one means removing its line and
// reloading the registry.
export const registryToken = pgTable(
	"registry_token",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		lastUsedAt: timestamp("last_used_at", { mode: "date" }),
		// bcrypt, the only hash registry:2's htpasswd auth accepts. The
		// plaintext secret is shown once at creation and never stored.
		secretHash: text("secret_hash").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		username: text("username").notNull().unique(),
	},
	(table) => [index("registryToken_userId_idx").on(table.userId)],
);

// Singleton row (id is always "default") holding DB overrides for
// instance-level config that otherwise defaults from env vars (see
// $lib/config.ts's envDefaults + applyInstanceSettings()). Every column is
// nullable : null means "fall back to the env default", a non-null value
// overrides it. Secrets (smtpPasswordEnc, each oauth provider's
// clientSecretEnc) use the same AES-256-GCM scheme as
// service.registryPasswordEnc.
export const instanceSettings = pgTable("instance_settings", {
	authCheckUrl: text("auth_check_url"),
	authCrossSubdomainCookies: boolean("auth_cross_subdomain_cookies"),
	authOrigin: text("auth_origin"),
	baseDomain: text("base_domain"),
	dnsProvider: text("dns_provider").$type<"pangolin">(),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	dockerNetworkName: text("docker_network_name"),
	dockerSocketPath: text("docker_socket_path"),
	emailOtpSignIn: boolean("email_otp_sign_in"),
	// The built-in registry's own settings. `registryAuthEnabled` turns on
	// htpasswd auth (see the registry_token table); `registryPublicHost` is
	// the hostname Traefik routes to it, null meaning it stays internal.
	// Exposing it without auth is refused, so a public registry is always a
	// closed one. `registryInternalSecretEnc` is the secret of the reserved
	// token Homerun itself pulls and pushes with once auth is on, so its own
	// scan pipeline keeps working : AES-256-GCM, same scheme as
	// service.registryPasswordEnc.
	registryAuthEnabled: boolean("registry_auth_enabled"),
	registryInternalSecretEnc: text("registry_internal_secret_enc"),
	registryPublicHost: text("registry_public_host"),
	vapidPrivateKeyEnc: text("vapid_private_key_enc"),
	vapidPublicKey: text("vapid_public_key"),
	garageAdminTokenEnc: text("garage_admin_token_enc"),
	garageEnabled: boolean("garage_enabled"),
	garagePublicHost: text("garage_public_host"),
	garageRpcSecretEnc: text("garage_rpc_secret_enc"),
	// {id, kind, name, baseUrl, clientId, clientSecretEnc, enabled}[] : OAuth
	// App registrations for git-hosting providers (see the Git Providers
	// page and $lib/services/git-provider.service.ts), separate from
	// oauthProviders above (those are for signing *into* Homerun itself via
	// an OIDC provider; these are for connecting *out* to GitHub/GitLab/
	// Gitea/Bitbucket to browse a user's repos when creating a git-based
	// service). Deliberately not part of applyInstanceSettings()'s merge :
	// same reasoning as onboardingCompletedAt, this isn't an env-default-
	// backed config value.
	gitProviders: jsonb("git_providers")
		.$type<GitProviderConfig[]>()
		.notNull()
		.default([]),
	id: text("id").primaryKey(),
	imageScanBlockFixableOnly: boolean("image_scan_block_fixable_only"),
	imageScanBlockSeverity: text(
		"image_scan_block_severity",
	).$type<BlockSeverity>(),
	imageScanEnabled: boolean("image_scan_enabled"),
	imageScanRequired: boolean("image_scan_required"),
	magicLinkSignIn: boolean("magic_link_sign_in"),
	retainedImagesPerService: integer("retained_images_per_service"),
	// {name, clientId, clientSecretEnc, discoveryUrl, enabled, pkce, scopes}[]
	// : see genericOAuth's config shape in $lib/services/auth.ts.
	oauthProviders: jsonb("oauth_providers")
		.$type<InstanceOauthProvider[]>()
		.notNull()
		.default([]),
	// Non-null once the onboarding wizard has been completed : gates every
	// (protected)/ route (see (protected)/+layout.server.ts). Unlike every
	// other column here, not part of the config-override merge in
	// $lib/config.ts : this is onboarding-flow state, not an instance config
	// value.
	onboardingCompletedAt: timestamp("onboarding_completed_at", {
		mode: "date",
	}),
	dependenciesBackfilledAt: timestamp("dependencies_backfilled_at", {
		mode: "date",
	}),
	// "standalone" (one container per service) |
	// "swarm" (a swarm service : replicas, rolling updates, overlay
	// networking). A fresh instance picks swarm when its daemon is already a
	// rootful swarm manager, see hooks.server.ts and docker/swarm.ts.
	orchestrationMode: text("orchestration_mode").$type<"standalone" | "swarm">(),
	pendingServiceRedeploy: boolean("pending_service_redeploy"),
	updateChannel: text("update_channel").$type<
		"canary" | "nightly" | "stable"
	>(),
	// Self-hosted Pangolin (https://api.pangolin.net/v1/docs/, a tunnel/
	// reverse-proxy manager, not a plain DNS API) : an alternative to the
	// Cloudflare integration above for instances that front themselves with
	// Pangolin instead of a DNS provider Traefik can ACME against directly.
	// When all four are set, a deployed service with `dnsResolvable` gets a
	// Pangolin Resource (subdomain under one of the org's registered Pangolin
	// domains) + a Target auto-created, pointing at this host's own Traefik
	// entrypoint through pangolinMainSiteName's tunnel, instead of the admin
	// wiring one up by hand for every service (see
	// $lib/services/pangolin.service.ts). Unset (the default) : no-op, same
	// "background automation defaults inert" posture as Cloudflare/
	// autoscaling/backups. Both integrations can be configured at once, each
	// runs independently in the deploy pipeline.
	pangolinApiBaseUrl: text("pangolin_api_base_url"),
	// AES-256-GCM ciphertext, same scheme as cloudflareApiTokenEnc.
	pangolinApiTokenEnc: text("pangolin_api_token_enc"),
	// The Pangolin "site" (tunnel agent) a created Resource's Target routes
	// to : must already exist in Pangolin, matched by name, this app never
	// creates a site itself.
	pangolinMainSiteName: text("pangolin_main_site_name"),
	pangolinNewtEndpoint: text("pangolin_newt_endpoint"),
	pangolinNewtId: text("pangolin_newt_id"),
	pangolinNewtSecretEnc: text("pangolin_newt_secret_enc"),
	pangolinOrgId: text("pangolin_org_id"),
	// When true, a created Resource keeps Pangolin's own SSO gate and this
	// app's per-service login wall steps aside for anything published through
	// Pangolin : one login instead of two. Default (false/null) is the
	// reverse, Homerun owns access and every Resource it creates is created
	// with `sso: false` (see $lib/services/pangolin.service.ts).
	pangolinOwnsAuth: boolean("pangolin_owns_auth"),
	// The host a Resource's Target points at, as resolved from the Pangolin
	// site agent (usually newt), null defaults to "localhost", which is only
	// right when that agent runs on this host with host networking : anything
	// else needs this host's LAN address.
	pangolinTargetHost: text("pangolin_target_host"),
	// Local port a Resource's Target forwards to on pangolinMainSiteName's
	// host, null defaults to 80 (this app's own Traefik entrypoint, assumed
	// to be running on the same host as the Pangolin site agent, HTTP-only :
	// Pangolin terminates the public TLS connection itself, same "DNS/edge
	// layer owns TLS, Traefik doesn't need to" posture as the Cloudflare
	// integration's plain, unproxied CNAME).
	pangolinTargetPort: integer("pangolin_target_port"),
	preferredSignInMethods: jsonb("preferred_sign_in_methods").$type<string[]>(),
	errorPages: jsonb("error_pages").$type<Partial<ErrorPagesSettings>>(),
	ipBans: jsonb("ip_bans").$type<Partial<IpBanSettings>>(),
	crowdsecUrl: text("crowdsec_url"),
	crowdsecMachineId: text("crowdsec_machine_id"),
	crowdsecPasswordEnc: text("crowdsec_password_enc"),
	defaultUiMode: text("default_ui_mode").$type<UiMode>(),
	otelCollectorEnabled: boolean("otel_collector_enabled"),
	traceRetentionDays: integer("trace_retention_days"),
	requirePasskey: boolean("require_passkey"),
	requireTwoFactor: boolean("require_two_factor"),
	resourceAlertReminderMinutes: integer("resource_alert_reminder_minutes"),
	resourceAlertSustainSeconds: integer("resource_alert_sustain_seconds"),
	resourceThresholds: jsonb("resource_thresholds").$type<
		Partial<Record<ResourceKind, Partial<Threshold>>>
	>(),
	smtpEnabled: boolean("smtp_enabled"),
	smtpFrom: text("smtp_from"),
	smtpHost: text("smtp_host"),
	smtpPasswordEnc: text("smtp_password_enc"),
	smtpPort: integer("smtp_port"),
	smtpSecure: boolean("smtp_secure"),
	smtpUser: text("smtp_user"),
	traefikAcmeEmail: text("traefik_acme_email"),
	traefikCertResolver: text("traefik_cert_resolver"),
	traefikDynamicConfigDir: text("traefik_dynamic_config_dir"),
	traefikEntrypoint: text("traefik_entrypoint"),
	traefikHttpCache: boolean("traefik_http_cache").default(false).notNull(),
	tlsCertEnc: text("tls_cert_enc"),
	tlsKeyEnc: text("tls_key_enc"),
	sshPrivateKeyEnc: text("ssh_private_key_enc"),
	sshPublicKey: text("ssh_public_key"),
	sshHost: text("ssh_host"),
	sshPort: integer("ssh_port"),
	sshUser: text("ssh_user"),
	sshHostKey: text("ssh_host_key"),
	tlsCertNames: jsonb("tls_cert_names").$type<string[]>().default([]).notNull(),
	tlsCertExpiresAt: timestamp("tls_cert_expires_at", { mode: "date" }),
	tlsCertIssuer: text("tls_cert_issuer"),
	updatedAt: timestamp("updated_at", { mode: "date" })
		.$onUpdate(() => new Date())
		.notNull(),
});

export type OauthTokenAuthMethod = "auto" | "basic" | "post";

export interface InstanceOauthProvider {
	clientId: string;
	clientSecretEnc: string;
	discoveredTokenAuth?: string[];
	discoveryUrl: string;
	enabled: boolean;
	label?: string;
	name: string;
	pkce: boolean;
	scopes: string[];
	signOutOfProvider?: boolean;
	tokenAuthMethod?: OauthTokenAuthMethod;
}

export type GitProviderKind = "github" | "gitlab" | "gitea" | "bitbucket";

export interface GitProviderConfig {
	// Referenced by git_connection.providerId and the /api/v1/git-providers/
	// [providerId]/* routes : not a DB FK since these live inside the
	// instance_settings JSON column, not their own table.
	baseUrl: string | null;
	clientId: string;
	clientSecretEnc: string;
	enabled: boolean;
	id: string;
	kind: GitProviderKind;
	name: string;
}

// A pending admin-sent invite to create an account : see InvitationDTO and
// the Users page's "Send invite" action. Accepting one (at
// /auth/accept-invite/[token]) creates the user directly via
// auth.api.createUser and sets acceptedAt; there's no separate account
// row until then.
export const invitation = pgTable(
	"invitation",
	{
		acceptedAt: timestamp("accepted_at", { mode: "date" }),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		email: text("email").notNull(),
		expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		invitedByUserId: text("invited_by_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		token: text("token").notNull().unique(),
	},
	(table) => [index("invitation_email_idx").on(table.email)],
);

export const template = pgTable(
	"template",
	{
		capAdd: jsonb("cap_add").$type<string[]>().default([]).notNull(),
		category: text("category"), // "database" | "cache" | "monitoring" | "automation" | "other"
		command: jsonb("command").$type<string[] | null>(),
		containerPort: integer("container_port").notNull(),
		devices: jsonb("devices").$type<string[]>().default([]).notNull(),
		entrypoint: jsonb("entrypoint").$type<string[] | null>(),
		envFiles: jsonb("env_files").$type<string[]>().default([]).notNull(),
		labels: jsonb("labels")
			.$type<Record<string, string>>()
			.default({})
			.notNull(),
		privileged: boolean("privileged").default(false).notNull(),
		publishedPorts: jsonb("published_ports")
			.$type<PublishedPort[]>()
			.default([])
			.notNull(),
		runAsUser: text("run_as_user"),
		cpuLimit: text("cpu_limit"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		description: text("description"),
		envVars: jsonb("env_vars").$type<Record<string, string>>().default({}),
		healthcheckCommand: text("healthcheck_command"),
		icon: text("icon"), // lucide icon name, looked up the same way SERVICE_STATUS_CONFIG maps a key to an icon component
		id: text("id").primaryKey(),
		image: text("image").notNull(),
		memoryLimitMb: integer("memory_limit_mb"),
		name: text("name").notNull(),
		// null = built-in (seeded), immutable : not owned by any user
		ownerId: text("owner_id").references(() => user.id, {
			onDelete: "cascade",
		}),
		restartPolicy: text("restart_policy").default("unless-stopped").notNull(),
		sourceUrl: text("source_url"),
		tag: text("tag").default("latest").notNull(),
		// Free-form search keywords ("sql", "s3", "monitoring"), matched by the
		// gallery's search box alongside name/description/image : a category is
		// one bucket per template, these are many and overlap.
		tags: text("tags").array().default([]).notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		volumes: jsonb("volumes").$type<string[]>().default([]).notNull(),
		websiteUrl: text("website_url"),
	},
	(table) => [index("template_ownerId_idx").on(table.ownerId)],
);

export const templateLink = pgTable(
	"template_link",
	{
		alias: text("alias").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		linkedTemplateId: text("linked_template_id")
			.notNull()
			.references(() => template.id, { onDelete: "cascade" }),
		templateId: text("template_id")
			.notNull()
			.references(() => template.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("templateLink_templateId_idx").on(table.templateId),
		uniqueIndex("templateLink_templateId_alias_uidx").on(
			table.templateId,
			table.alias,
		),
	],
);

export const service = pgTable(
	"service",
	{
		authAllowedGroups: jsonb("auth_allowed_groups")
			.$type<string[]>()
			.default([])
			.notNull(),
		authAllowedEmails: jsonb("auth_allowed_emails")
			.$type<string[]>()
			.default([])
			.notNull(),
		authAllowedUserIds: jsonb("auth_allowed_user_ids")
			.$type<string[]>()
			.default([])
			.notNull(),
		authProviders: jsonb("auth_providers")
			.$type<string[]>()
			.default([])
			.notNull(),
		authRequired: boolean("auth_required").default(false).notNull(),
		authPaths: jsonb("auth_paths").$type<string[]>().default([]).notNull(),
		authPathsMode: text("auth_paths_mode")
			.$type<AuthPathsMode>()
			.default("all")
			.notNull(),
		blockedPaths: jsonb("blocked_paths")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewAuthAllowedGroups: jsonb("preview_auth_allowed_groups")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewAuthAllowedEmails: jsonb("preview_auth_allowed_emails")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewAuthAllowedUserIds: jsonb("preview_auth_allowed_user_ids")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewAuthProviders: jsonb("preview_auth_providers")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewAuthRequired: boolean("preview_auth_required")
			.default(false)
			.notNull(),
		autoRollback: boolean("auto_rollback").default(false).notNull(),
		capAdd: jsonb("cap_add").$type<string[]>().default([]).notNull(),
		command: jsonb("command").$type<string[] | null>(),
		devices: jsonb("devices").$type<string[]>().default([]).notNull(),
		entrypoint: jsonb("entrypoint").$type<string[] | null>(),
		envFiles: jsonb("env_files").$type<string[]>().default([]).notNull(),
		labels: jsonb("labels")
			.$type<Record<string, string>>()
			.default({})
			.notNull(),
		privileged: boolean("privileged").default(false).notNull(),
		runAsUser: text("run_as_user"),
		// Registry to use as a git-build layer cache (git mode only, see
		// internal/agent/build.go) : null means no cache-from/cache-to, every
		// build is from scratch, same as before this existed.
		buildCacheRegistryId: text("build_cache_registry_id").references(
			() => buildCacheRegistry.id,
			{ onDelete: "set null" },
		),
		buildCacheBuiltin: boolean("build_cache_builtin").default(false).notNull(),
		// A remote host to run the git-build step on instead of this one
		// (null : build locally). The built image only exists on the build
		// server's own daemon, so deployService requires buildCacheRegistryId
		// alongside it : it pushes the final image there and pulls it back
		// here before starting the container. See deploy.service.ts.
		buildServerRemoteHostId: text("build_server_remote_host_id").references(
			() => remoteHost.id,
			{ onDelete: "set null" },
		),
		// "image" (bring-your-own, the original/default) | "git" (clone +
		// build a Dockerfile locally : see internal/jobs/deploy/build.go).
		// When "git", `image`/`tag` are overwritten after each successful
		// build with the resulting local tag, not user-editable directly.
		buildSource: text("build_source")
			.$type<"image" | "git">()
			.default("image")
			.notNull(),
		containerId: text("container_id"),
		containerPort: integer("container_port").notNull(),
		cpuLimit: text("cpu_limit"),
		healthcheckCommand: text("healthcheck_command"),
		healthcheckDisabled: boolean("healthcheck_disabled")
			.default(false)
			.notNull(),
		healthcheckIntervalSeconds: integer("healthcheck_interval_seconds"),
		healthcheckRetries: integer("healthcheck_retries"),
		healthcheckStartPeriodSeconds: integer("healthcheck_start_period_seconds"),
		healthcheckTimeoutSeconds: integer("healthcheck_timeout_seconds"),
		// Errors older than this are hidden on the Observability tab. Set by
		// the "Clear errors" button, and automatically by a deploy that goes
		// live : errorsDismissedByDeploymentId is that revision.
		errorsDismissedAt: timestamp("errors_dismissed_at", { mode: "date" }),
		errorsDismissedByDeploymentId: text("errors_dismissed_by_deployment_id"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		// Standard 5-field cron expression ("min hour day month weekday"),
		// evaluated in the server's local time : see $lib/services/cron.service.ts.
		// Null/disabled unless the user opts in via the Overview tab.
		cronEnabled: boolean("cron_enabled").default(false).notNull(),
		cronLastRunAt: timestamp("cron_last_run_at", { mode: "date" }),
		cronSchedule: text("cron_schedule"),
		// pending | pulling | starting | running | stopped | failed
		currentStatus: text("current_status")
			.$type<ContainerStatus>()
			.default("pending")
			.notNull(),
		defaultDomainEnabled: boolean("default_domain_enabled")
			.default(true)
			.notNull(),
		domains: text("domains").array().default(sql`'{}'::text[]`).notNull(),
		category: text("category"),
		httpCacheTtl: integer("http_cache_ttl"),
		icon: text("icon"),
		domainPorts: jsonb("domain_ports")
			.$type<Record<string, number>>()
			.default({})
			.notNull(),
		primaryDomain: text("primary_domain"),
		// AES-256-GCM ciphertext (PEM), same scheme as registryPasswordEnc.
		// Only take effect together : see
		// $lib/services/docker/custom-ssl.ts. Requires the admin's own opt-in
		// (TRAEFIK_DYNAMIC_CONFIG_DIR + a Traefik file-provider config
		// change, see compose.yaml) to actually be picked up by Traefik.
		customSslCertEnc: text("custom_ssl_cert_enc"),
		customSslKeyEnc: text("custom_ssl_key_enc"),
		// running | stopped : the user's intent
		desiredState: text("desired_state")
			.$type<"running" | "stopped">()
			.default("stopped")
			.notNull(),
		// When false, no Traefik router/service labels are attached at deploy
		// time : the container never gets a public <slug>.<baseDomain>, only
		// reachable over the internal network(s) it's attached to (the shared
		// network by slug alias, plus its stack's network if any).
		dnsResolvable: boolean("dns_resolvable").default(true).notNull(),
		envVars: jsonb("env_vars").$type<Record<string, string>>().default({}),
		// Bake file relative to gitBuildContext, "docker-bake.hcl" when unset.
		gitBakeFile: text("git_bake_file"),
		// Bake target or group resolving to one target, "default" when unset.
		gitBuildTarget: text("git_build_target"),
		gitBuildContext: text("git_build_context"),
		gitBuildMethod: text("git_build_method")
			.$type<BuildMethod>()
			.default("dockerfile")
			.notNull(),
		// Relative to gitBuildContext. Defaults to "Dockerfile" when unset.
		gitDockerfilePath: text("git_dockerfile_path"),
		// Branch, tag or full commit SHA : see $lib/git-ref.ts.
		gitRef: text("git_ref"),
		gitUrl: text("git_url"),
		gitProviderId: text("git_provider_id"),
		gitRepo: text("git_repo"),
		gitWatchPaths: jsonb("git_watch_paths")
			.$type<string[]>()
			.default([])
			.notNull(),
		gitIgnorePaths: jsonb("git_ignore_paths")
			.$type<string[]>()
			.default([])
			.notNull(),
		autoDeployOnPush: boolean("auto_deploy_on_push").default(false).notNull(),
		gitWebhookId: text("git_webhook_id"),
		gitWebhookSecretEnc: text("git_webhook_secret_enc"),
		gitWebhookError: text("git_webhook_error"),
		gitWebhookReconnect: boolean("git_webhook_reconnect")
			.default(false)
			.notNull(),
		gitPollEnabled: boolean("git_poll_enabled").default(false).notNull(),
		gitLastSeenCommit: text("git_last_seen_commit"),
		previewsEnabled: boolean("previews_enabled").default(false).notNull(),
		previewDomainTemplate: text("preview_domain_template"),
		previewInheritEnv: boolean("preview_inherit_env").default(true).notNull(),
		previewEnvOverrides: jsonb("preview_env_overrides")
			.$type<Record<string, string>>()
			.default({})
			.notNull(),
		previewCopyVolumes: boolean("preview_copy_volumes")
			.default(false)
			.notNull(),
		previewBranchInclude: jsonb("preview_branch_include")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewBranchExclude: jsonb("preview_branch_exclude")
			.$type<string[]>()
			.default([])
			.notNull(),
		previewDefaultDomain: boolean("preview_default_domain")
			.default(true)
			.notNull(),
		previewReportGithub: boolean("preview_report_github")
			.default(true)
			.notNull(),
		previewParentId: text("preview_parent_id").references(
			(): AnyPgColumn => service.id,
			{ onDelete: "cascade" },
		),
		previewPrNumber: integer("preview_pr_number"),
		previewPrTitle: text("preview_pr_title"),
		previewBranch: text("preview_branch"),
		channelsEnabled: boolean("channels_enabled").default(false).notNull(),
		channelBranch: text("channel_branch"),
		channelTagPattern: text("channel_tag_pattern").default("v*").notNull(),
		channelCanaryDomain: text("channel_canary_domain"),
		channelCanary: boolean("channel_canary").default(false).notNull(),
		environmentName: text("environment_name"),
		id: text("id").primaryKey(),
		// e.g. "ghcr.io/acme/api"
		image: text("image").notNull(),
		imageScanEnabled: boolean("image_scan_enabled").default(true).notNull(),
		memoryLimitMb: integer("memory_limit_mb"),
		name: text("name").notNull(),
		// "bridge" (default : the shared homerun + stack network,
		// Traefik-routed) | "host" (shares the host's network namespace
		// directly, e.g. for mDNS/SSDP-dependent apps like Home Assistant :
		// no Traefik routing, no internal slug alias, not on any Docker
		// network at all; Docker doesn't allow combining host mode with
		// other network attachments). Forces dnsResolvable false server-side
		// regardless of what's submitted : see docker/containers.ts.
		networkMode: text("network_mode")
			.$type<"bridge" | "host">()
			.default("bridge")
			.notNull(),
		// "tcp" | "udp" | "both" : which protocol(s) containerPort is exposed
		// under (Docker's ExposedPorts declaration). Informational only in
		// bridge mode, where containerPort is reached through Traefik and
		// host ports come from publishedPorts; the container's actual
		// host-visible port(s) in host mode.
		portProtocol: text("port_protocol")
			.$type<"tcp" | "udp" | "both">()
			.default("tcp")
			.notNull(),
		publishedPorts: jsonb("published_ports")
			.$type<PublishedPort[]>()
			.default([])
			.notNull(),
		// nullable : grouping is opt-in, ungrouped services stay valid
		stackId: text("stack_id").references(() => stack.id, {
			onDelete: "set null",
		}),
		// AES-256-GCM ciphertext : see $lib/services/secrets
		registryPasswordEnc: text("registry_password_enc"),
		registryUrl: text("registry_url"),
		registryUsername: text("registry_username"),
		requireStatusChecks: boolean("require_status_checks")
			.default(false)
			.notNull(),
		requiredStatusChecks: jsonb("required_status_checks")
			.$type<string[]>()
			.default([])
			.notNull(),
		// Desired replica count, swarm-mode only (instanceSettings.orchestrationMode
		// = "swarm") : ignored entirely in standalone mode, always 1 container.
		// Editable on the Compute tab.
		replicas: integer("replicas").default(1).notNull(),
		// always | missing | never
		pullPolicy: text("pull_policy")
			.$type<PullPolicy>()
			.default("always")
			.notNull(),
		// no | always | on-failure | unless-stopped
		restartPolicy: text("restart_policy").default("unless-stopped").notNull(),
		secretEnvKeys: jsonb("secret_env_keys")
			.$type<string[]>()
			.default([])
			.notNull(),
		// subdomain: <slug>.<baseDomain>
		slug: text("slug").notNull().unique(),
		// Swarm mode's equivalent of `containerId` : the Docker Swarm service
		// id backing this Homerun service, when deployed under
		// orchestrationMode="swarm". `containerId` stays null in that case
		// (there's no single container, the Engine's Task API resolves the
		// live container id per-task when one's needed, e.g. the Terminal
		// tab : see docker/swarm.ts).
		swarmServiceId: text("swarm_service_id"),
		uptimeEnabled: boolean("uptime_enabled").default(true).notNull(),
		tracesEnabled: boolean("traces_enabled").default(false).notNull(),
		tag: text("tag").default("latest").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("service_userId_idx").on(table.userId),
		index("service_slug_idx").on(table.slug),
		index("service_stackId_idx").on(table.stackId),
		uniqueIndex("service_previewParentId_previewPrNumber_uidx").on(
			table.previewParentId,
			table.previewPrNumber,
		),
	],
);

export const deployment = pgTable(
	"deployment",
	{
		buildSource: text("build_source").$type<"image" | "git">(),
		configSnapshot: jsonb("config_snapshot").$type<RevisionConfig>(),
		containerId: text("container_id"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		environment: text("environment").default("production").notNull(),
		errorMessage: text("error_message"),
		finishedAt: timestamp("finished_at", { mode: "date" }),
		// The commit this revision actually built, for a git-sourced service :
		// "latest" on a branch says nothing about what ran, the SHA does.
		gitCommit: text("git_commit"),
		gitRef: text("git_ref"),
		health: text("health").$type<RevisionHealth>(),
		healthReason: text("health_reason"),
		id: text("id").primaryKey(),
		imageDigest: text("image_digest"),
		imageId: text("image_id"),
		// The image:tag this revision ran, recorded at deploy time so a later
		// retag doesn't rewrite history.
		imageRef: text("image_ref"),
		// Progress lines appended live during deploy ("Pulling image...",
		// "Starting container...") : polled by the Overview tab while a deploy
		// is in flight, kept around after for a lightweight audit trail.
		log: text("log").default(""),
		restoreConfig: boolean("restore_config").default(false).notNull(),
		rollbackOfDeploymentId: text("rollback_of_deployment_id"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		startedAt: timestamp("started_at", { mode: "date" }),
		// pending | pulling | starting | running | failed | stopped
		status: text("status")
			.$type<ContainerStatus>()
			.default("pending")
			.notNull(),
		trigger: text("trigger").$type<DeployTrigger>(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("deployment_serviceId_idx").on(table.serviceId),
		index("deployment_userId_idx").on(table.userId),
	],
);

// A named, reusable backup destination, configured once on the Backup
// Destinations page and picked by id from any number of volumes. The columns
// are named for S3, the first type; an sftp/smb/webdav row reuses them:
// endpoint is the host[:port] or URL, bucket the path, accessKeyId the
// username, secretAccessKeyEnc the password or private key, region is empty.
export const s3Destination = pgTable(
	"s3_destination",
	{
		accessKeyId: text("access_key_id").notNull(),
		bucket: text("bucket").notNull(),
		capacityAlertPercent: integer("capacity_alert_percent")
			.default(85)
			.notNull(),
		capacityAlertedAt: timestamp("capacity_alerted_at", { mode: "date" }),
		capacityCheckedAt: timestamp("capacity_checked_at", { mode: "date" }),
		capacityError: text("capacity_error"),
		capacityFreeBytes: bigint("capacity_free_bytes", { mode: "number" }),
		capacityTotalBytes: bigint("capacity_total_bytes", { mode: "number" }),
		capacityUsedBytes: bigint("capacity_used_bytes", { mode: "number" }),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		// S3-compatible endpoint, e.g. "https://s3.us-east-1.amazonaws.com" or
		// a self-hosted MinIO URL.
		endpoint: text("endpoint").notNull(),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		region: text("region").notNull(),
		// AES-256-GCM ciphertext, same scheme as service.registryPasswordEnc.
		secretAccessKeyEnc: text("secret_access_key_enc").notNull(),
		type: text("type").$type<DestinationType>().default("s3").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("s3Destination_userId_idx").on(table.userId)],
);

export const objectStore = pgTable(
	"object_store",
	{
		accessKeyId: text("access_key_id").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		endpoint: text("endpoint").notNull(),
		id: text("id").primaryKey(),
		kind: text("kind").$type<ObjectStoreKind>().notNull(),
		name: text("name").notNull(),
		region: text("region").notNull(),
		secretAccessKeyEnc: text("secret_access_key_enc").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("objectStore_userId_idx").on(table.userId)],
);

export const publicBucket = pgTable(
	"public_bucket",
	{
		bucket: text("bucket").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		storeId: text("store_id")
			.notNull()
			.references(() => objectStore.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.storeId, table.bucket] })],
);

export const iacProject = pgTable(
	"iac_project",
	{
		bucket: text("bucket").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		prefix: text("prefix").default("").notNull(),
		scope: text("scope"),
		slug: text("slug").notNull().unique(),
		storeId: text("store_id")
			.notNull()
			.references(() => objectStore.id, { onDelete: "cascade" }),
		tool: text("tool").$type<IacTool>().default("terraform").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("iacProject_storeId_idx").on(table.storeId)],
);

export const iacStateVersion = pgTable(
	"iac_state_version",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		lineage: text("lineage"),
		md5: text("md5").notNull(),
		objectKey: text("object_key").notNull(),
		projectId: text("project_id")
			.notNull()
			.references(() => iacProject.id, { onDelete: "cascade" }),
		rollbackOfId: text("rollback_of_id"),
		serial: integer("serial").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		userId: text("user_id").references(() => user.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		index("iacStateVersion_projectId_createdAt_idx").on(
			table.projectId,
			table.createdAt,
		),
	],
);

export const iacStateLock = pgTable("iac_state_lock", {
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	info: jsonb("info").$type<Record<string, unknown>>(),
	lockId: text("lock_id").notNull(),
	projectId: text("project_id")
		.primaryKey()
		.references(() => iacProject.id, { onDelete: "cascade" }),
	userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
});

export const storageVolume = pgTable(
	"storage_volume",
	{
		// Cron expression for scheduled backups, evaluated by the same
		// scheduler tick as service redeploys : see $lib/services/cron.service.ts.
		backupEnabled: boolean("backup_enabled").default(false).notNull(),
		backupLastRunAt: timestamp("backup_last_run_at", { mode: "date" }),
		// Object key prefix within the destination's bucket, e.g.
		// "backups/my-app" : per-volume, even when several volumes share one
		// destination.
		backupPrefix: text("backup_prefix"),
		backupPreCommand: text("backup_pre_command"),
		backupPreCommandServiceId: text("backup_pre_command_service_id").references(
			() => service.id,
			{ onDelete: "set null" },
		),
		backupSchedule: text("backup_schedule"),
		backupStopServices: boolean("backup_stop_services")
			.default(false)
			.notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		description: text("description"),
		id: text("id").primaryKey(),
		// Docker Binds source: either a bind-mount host path ("/mnt/data/foo")
		// or a Docker-managed named volume ("homerun-vol-xyz") : same field,
		// Docker's Binds syntax tells them apart by whether it looks like a
		// path. `kind` just drives which the create form asks for.
		// "bind" | "volume"
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		previewServiceId: text("preview_service_id").references(
			(): AnyPgColumn => service.id,
			{ onDelete: "cascade" },
		),
		seedFrom: text("seed_from"),
		s3DestinationId: text("s3_destination_id").references(
			() => s3Destination.id,
			{ onDelete: "set null" },
		),
		source: text("source").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("storageVolume_userId_idx").on(table.userId)],
);

// One storage volume can be mounted into several services : that's what
// makes it "shared" across a stack, no separate stack-level concept
// needed (see TODO.md).
export const serviceVolume = pgTable(
	"service_volume",
	{
		containerPath: text("container_path").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		readOnly: boolean("read_only").default(false).notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		volumeId: text("volume_id")
			.notNull()
			.references(() => storageVolume.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("serviceVolume_serviceId_idx").on(table.serviceId),
		index("serviceVolume_volumeId_idx").on(table.volumeId),
	],
);

export const serviceDependency = pgTable(
	"service_dependency",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		dependsOnId: text("depends_on_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("serviceDependency_pair_idx").on(
			table.serviceId,
			table.dependsOnId,
		),
		index("serviceDependency_dependsOnId_idx").on(table.dependsOnId),
	],
);

// One row per backup attempt (scheduled or manual "Run now"), the run log
// backing the dedicated Backups page : `storage_volume.backupLastRunAt`
// alone only ever remembered the *last* timestamp, not whether it succeeded
// or a history to look back at. Inserted/finalized from
// BackupService.runBackup() (the one place both the scheduler and the
// manual action funnel through), not duplicated at each call site.
export const backupRun = pgTable(
	"backup_run",
	{
		error: text("error"),
		finishedAt: timestamp("finished_at", { mode: "date" }),
		id: text("id").primaryKey(),
		jobId: text("job_id"),
		key: text("key"),
		kind: text("kind").$type<BackupRunKind>().default("backup").notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		startedAt: timestamp("started_at", { mode: "date" }).notNull(),
		// null while the run is still in progress (startedAt set, finishedAt
		// not yet), true/false once finalized.
		success: boolean("success"),
		volumeId: text("volume_id")
			.notNull()
			.references(() => storageVolume.id, { onDelete: "cascade" }),
	},
	(table) => [index("backupRun_volumeId_idx").on(table.volumeId)],
);

// A user-defined scheduled task, run either as a throwaway container
// (kind "image", see DockerService.runOneOff) or as a shell command on the
// host the app itself runs on (kind "exec", admin-only : it inherits this
// process's own privileges). Independent of service.cronSchedule, which
// redeploys an existing service rather than running a task.
export const cronJob = pgTable(
	"cron_job",
	{
		// Shell command for kind "exec"; an optional command override for
		// kind "image" (blank : the image's own entrypoint/command).
		command: text("command"),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		description: text("description"),
		dockerSocket: boolean("docker_socket").default(false).notNull(),
		enabled: boolean("enabled").default(false).notNull(),
		envVars: jsonb("env_vars").$type<Record<string, string>>().default({}),
		files: jsonb("files").$type<CronJobFile[]>().default([]).notNull(),
		id: text("id").primaryKey(),
		image: text("image"),
		kind: text("kind").$type<CronJobKind>().notNull(),
		lastRunAt: timestamp("last_run_at", { mode: "date" }),
		mounts: jsonb("mounts").$type<CronJobMount[]>().default([]).notNull(),
		name: text("name").notNull(),
		// AES-256-GCM ciphertext : see $lib/services/secrets.
		registryPasswordEnc: text("registry_password_enc"),
		registryUrl: text("registry_url"),
		registryUsername: text("registry_username"),
		// Which daemon a kind "image" job runs its container on : null is
		// this host's own socket. Ignored for kind "exec", which is a shell
		// command on the machine this app runs on by definition.
		remoteHostId: text("remote_host_id").references(() => remoteHost.id, {
			onDelete: "set null",
		}),
		runAsUser: text("run_as_user"),
		runtime: text("runtime").$type<ScriptRuntime>(),
		// Standard 5-field cron expression, evaluated in the server's local
		// time by the same matcher every other schedule in this app uses.
		schedule: text("schedule").notNull(),
		source: text("source"),
		tag: text("tag").default("latest"),
		timeoutSeconds: integer("timeout_seconds").default(900).notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("cronJob_userId_idx").on(table.userId)],
);

// One row per cron job attempt (scheduled or manual "Run now"), including
// the command's own output : same shape as backupRun, plus what it printed.
export const cronJobRun = pgTable(
	"cron_job_run",
	{
		cronJobId: text("cron_job_id")
			.notNull()
			.references(() => cronJob.id, { onDelete: "cascade" }),
		error: text("error"),
		exitCode: integer("exit_code"),
		finishedAt: timestamp("finished_at", { mode: "date" }),
		id: text("id").primaryKey(),
		jobId: text("job_id"),
		output: text("output").default(""),
		startedAt: timestamp("started_at", { mode: "date" }).notNull(),
		// null while the run is still in progress, true/false once finalized.
		success: boolean("success"),
		trigger: text("trigger").$type<CronJobRunTrigger>(),
	},
	(table) => [index("cronJobRun_cronJobId_idx").on(table.cronJobId)],
);

// Persisted warn/error-level application log entries, captured by
// $lib/logger.ts's Logger.warn()/error() (best-effort, never blocks the
// caller) so the per-service Errors tab can show app-level failures
// alongside deployment failures, not just deploy failures : see TODO.md.
// serviceId is populated heuristically (message text scanned for a
// "service=<uuid>" token most call sites already include, e.g. deploy/Docker
// logs) rather than threaded explicitly through every one of the ~40
// existing Logger call sites : null means "not attributable to one service",
// still shown on a future instance-wide log view, just not on any one
// service's Errors tab.
export const appLog = pgTable(
	"app_log",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		level: text("level").$type<"warn" | "error">().notNull(),
		message: text("message").notNull(),
		// JSON-stringified extra args passed to logger.warn()/error(), if any.
		metadata: text("metadata"),
		scope: text("scope"),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		index("appLog_createdAt_idx").on(table.createdAt),
		index("appLog_serviceId_idx").on(table.serviceId),
	],
);

// The bell-icon feed's backing rows : one per user-facing lifecycle event
// (new deployment, cron auto-redeploy, start/stop, deploy failure, new
// service). Separate from appLog above : appLog is app-internal warn/error
// logging (the Errors tab), this is a curated, user-scoped notification
// feed, written explicitly at each event site rather than derived from logs.
export const notification = pgTable(
	"notification",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		detail: text("detail"),
		id: text("id").primaryKey(),
		message: text("message").notNull(),
		readAt: timestamp("read_at", { mode: "date" }),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "cascade",
		}),
		type: text("type")
			.$type<
				| "deploy_success"
				| "deploy_failure"
				| "service_created"
				| "service_started"
				| "service_stopped"
				| "auto_redeploy"
				| "app_runtime_error"
				| "image_scan_critical"
				| "build_checks_failed"
				| "deploy_unhealthy"
				| "deploy_rolled_back"
				| "resource_alert"
				| "update_failed"
				| "docker_wedged"
				| "error_issue"
				| "scheduled_summary"
				| "scheduled_failure"
			>()
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("notification_userId_createdAt_idx").on(
			table.userId,
			table.createdAt,
		),
	],
);

/**
 * One point on the resource graphs, written every minute by
 * services/stats-sampler.ts. `serviceId` null is the host itself, so the
 * dashboard's own chart and a service's scoped chart read the same table.
 *
 * Deliberately a raw sample rather than pre-rolled buckets: at a minute
 * apart, a year of host samples is ~525k rows and Postgres aggregates them
 * per range at query time (see StatSampleDTO.history), which is far less
 * machinery than maintaining rollup tables, and the retention prune keeps
 * the table from growing without bound.
 */
export const statSample = pgTable(
	"stat_sample",
	{
		cpuPercent: doublePrecision("cpu_percent").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		diskUsedGb: doublePrecision("disk_used_gb"),
		id: text("id").primaryKey(),
		memLimitMb: doublePrecision("mem_limit_mb"),
		memUsedMb: doublePrecision("mem_used_mb").notNull(),
		// Cumulative counters as the daemon reports them, not deltas : a
		// container's own counters reset when it restarts, so the rate is
		// derived per bucket at read time and clamped at zero.
		netRxBytes: doublePrecision("net_rx_bytes"),
		netTxBytes: doublePrecision("net_tx_bytes"),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "cascade",
		}),
	},
	(table) => [
		index("statSample_serviceId_createdAt_idx").on(
			table.serviceId,
			table.createdAt,
		),
	],
);

/**
 * One liveness probe result, **appended** every tick : the panel draws the last
 * few dozen as a heartbeat strip, so history is the point, and "now" is just
 * the newest row per (service, kind).
 *
 * `internal` is "the container's own port answers on the Docker network";
 * `external` is "the hostname Traefik publishes answers". They fail
 * independently and for different reasons, which is the whole point of probing
 * both. Retention is a week, pruned by the probe itself.
 */
export const trafficSample = pgTable(
	"traffic_sample",
	{
		bytesIn: doublePrecision("bytes_in").notNull(),
		bytesOut: doublePrecision("bytes_out").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		durationMs: doublePrecision("duration_ms").notNull(),
		id: text("id").primaryKey(),
		requests: integer("requests").notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		status4xx: integer("status_4xx").notNull(),
		status5xx: integer("status_5xx").notNull(),
	},
	(table) => [
		index("trafficSample_serviceId_createdAt_idx").on(
			table.serviceId,
			table.createdAt,
		),
	],
);

export const uptimeCheck = pgTable(
	"uptime_check",
	{
		checkedAt: timestamp("checked_at", { mode: "date" }).notNull(),
		detail: text("detail"),
		id: text("id").primaryKey(),
		kind: text("kind").$type<"internal" | "external">().notNull(),
		latencyMs: integer("latency_ms"),
		ok: boolean("ok").notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		target: text("target"),
	},
	(table) => [
		index("uptimeCheck_serviceId_kind_checkedAt_idx").on(
			table.serviceId,
			table.kind,
			table.checkedAt,
		),
	],
);

export const imageScan = pgTable(
	"image_scan",
	{
		counts: jsonb("counts").$type<SeverityCounts>().notNull(),
		deploymentId: text("deployment_id").references(() => deployment.id, {
			onDelete: "set null",
		}),
		digest: text("digest"),
		error: text("error"),
		findings: jsonb("findings").$type<ImageScanFinding[]>().notNull(),
		fixableCounts: jsonb("fixable_counts").$type<SeverityCounts>(),
		id: text("id").primaryKey(),
		imageRef: text("image_ref").notNull(),
		scannedAt: timestamp("scanned_at", { mode: "date" }).notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		status: text("status").$type<ImageScanStatus>().notNull(),
		totalFindings: integer("total_findings").default(0).notNull(),
	},
	(table) => [
		index("imageScan_serviceId_scannedAt_idx").on(
			table.serviceId,
			table.scannedAt,
		),
	],
);

export const job = pgTable(
	"job",
	{
		attempts: integer("attempts").default(0).notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		dedupeKey: text("dedupe_key"),
		dependsOnJobId: text("depends_on_job_id"),
		error: text("error"),
		exclusive: boolean("exclusive").default(false).notNull(),
		executorError: text("executor_error"),
		executorResult: jsonb("executor_result").$type<Record<string, unknown>>(),
		finishedAt: timestamp("finished_at", { mode: "date" }),
		heartbeatAt: timestamp("heartbeat_at", { mode: "date" }),
		id: text("id").primaryKey(),
		lockKey: text("lock_key"),
		log: text("log").default("").notNull(),
		maxAttempts: integer("max_attempts").default(1).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		priority: integer("priority").default(0).notNull(),
		progressAt: timestamp("progress_at", { mode: "date" }),
		result: jsonb("result").$type<Record<string, unknown>>(),
		runAt: timestamp("run_at", { mode: "date" }).notNull(),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "cascade",
		}),
		spec: text("spec"),
		stage: text("stage").$type<JobStage>(),
		startedAt: timestamp("started_at", { mode: "date" }),
		status: text("status").$type<JobStatus>().default("queued").notNull(),
		title: text("title").notNull(),
		type: text("type").$type<JobType>().notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		workerId: text("worker_id"),
		workerVersion: text("worker_version"),
	},
	(table) => [
		index("job_status_runAt_idx").on(table.status, table.runAt),
		index("job_status_stage_idx").on(table.status, table.stage),
		index("job_userId_createdAt_idx").on(table.userId, table.createdAt),
		uniqueIndex("job_type_dedupeKey_queued_uidx")
			.on(table.type, table.dedupeKey)
			.where(sql`${table.status} = 'queued'`),
	],
);

// One user's OAuth connection to one configured git provider (see
// instanceSettings.gitProviders) : the access/refresh token that lets
// $lib/services/git-provider.service.ts list that user's repos and check
// for a Dockerfile when creating a git-based service. providerId references
// a GitProviderConfig.id (not a DB FK, same reasoning as appLog.serviceId
// vs. the JSON-embedded provider configs : see gitProviders' docstring).
export const gitConnection = pgTable(
	"git_connection",
	{
		accessTokenEnc: text("access_token_enc").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		// Null for providers whose tokens don't expire (classic GitHub OAuth
		// Apps) : present for GitLab/Gitea/Bitbucket, which do issue
		// short-lived tokens with a refresh token.
		expiresAt: timestamp("expires_at", { mode: "date" }),
		id: text("id").primaryKey(),
		providerId: text("provider_id").notNull(),
		providerKind: text("provider_kind").$type<GitProviderKind>().notNull(),
		// The connected account's own username on that provider : shown in
		// the UI so it's obvious *which* account is connected.
		providerUsername: text("provider_username").notNull(),
		refreshTokenEnc: text("refresh_token_enc"),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		// One connection per user per provider : reconnecting replaces it
		// rather than accumulating duplicates.
		uniqueIndex("gitConnection_userId_providerId_uidx").on(
			table.userId,
			table.providerId,
		),
	],
);

// One row per user, the Appearance tab's backing store (/profile/appearance)
// : dashboard-only cosmetic preferences, distinct from instanceSettings
// (instance-wide, admin-only config) above. userId is the primary key itself
// rather than a separate id + unique index, since this is genuinely a 1:1
// extension of one user row, same reasoning as a join table's composite key.
export const userPreferences = pgTable("user_preferences", {
	// Nullable hex string ("#rrggbb") overriding the built-in --color-accent
	// CSS var app-wide within (protected)/ : null means "use the built-in
	// default", see (protected)/+layout.svelte.
	accentColor: text("accent_color"),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	palette: text("palette"),
	perPage: integer("per_page").default(50).notNull(),
	preset: text("preset").$type<Preset>(),
	surfaceStyle: text("surface_style")
		.$type<SurfaceStyle>()
		.default("glass")
		.notNull(),
	tabLayout: text("tab_layout")
		.$type<TabLayout>()
		.default("horizontal")
		.notNull(),
	// "system" (default, off the OS's own light/dark preference) | "light" |
	// "dark" : applied via the mode-watcher package already mounted in the
	// root layout (src/routes/+layout.svelte), this table is just its
	// account-level persistence layer so the choice follows the user across
	// browsers/devices instead of staying purely in one browser's localStorage.
	theme: text("theme")
		.$type<"light" | "dark" | "system">()
		.default("system")
		.notNull(),
	uiMode: text("ui_mode").$type<UiMode>(),
	updatedAt: timestamp("updated_at", { mode: "date" })
		.$onUpdate(() => new Date())
		.notNull(),
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
});

// ─── Relations ─────────────────────────────────────────────────────────────

export const userRelations = relations(user, ({ many }) => ({
	accounts: many(account),
	deployments: many(deployment),
	passkeys: many(passkey),
	stacks: many(stack),
	services: many(service),
	sessions: many(session),
	storageVolumes: many(storageVolume),
	templates: many(template),
}));

export const stackRelations = relations(stack, ({ one, many }) => ({
	services: many(service),
	user: one(user, { fields: [stack.userId], references: [user.id] }),
}));

export const templateRelations = relations(template, ({ one, many }) => ({
	owner: one(user, { fields: [template.ownerId], references: [user.id] }),
	links: many(templateLink, { relationName: "templateLinks" }),
}));

export const templateLinkRelations = relations(templateLink, ({ one }) => ({
	linkedTemplate: one(template, {
		fields: [templateLink.linkedTemplateId],
		references: [template.id],
	}),
	template: one(template, {
		fields: [templateLink.templateId],
		references: [template.id],
		relationName: "templateLinks",
	}),
}));

export const serviceRelations = relations(service, ({ one, many }) => ({
	dependedOnBy: many(serviceDependency, { relationName: "dependedOnBy" }),
	dependencies: many(serviceDependency, { relationName: "dependencies" }),
	deployments: many(deployment),
	stack: one(stack, {
		fields: [service.stackId],
		references: [stack.id],
	}),
	user: one(user, { fields: [service.userId], references: [user.id] }),
	volumeMounts: many(serviceVolume),
}));

export const deploymentRelations = relations(deployment, ({ one }) => ({
	service: one(service, {
		fields: [deployment.serviceId],
		references: [service.id],
	}),
	user: one(user, { fields: [deployment.userId], references: [user.id] }),
}));

export const storageVolumeRelations = relations(
	storageVolume,
	({ one, many }) => ({
		mounts: many(serviceVolume),
		user: one(user, { fields: [storageVolume.userId], references: [user.id] }),
	}),
);

export const serviceVolumeRelations = relations(serviceVolume, ({ one }) => ({
	service: one(service, {
		fields: [serviceVolume.serviceId],
		references: [service.id],
	}),
	volume: one(storageVolume, {
		fields: [serviceVolume.volumeId],
		references: [storageVolume.id],
	}),
}));

export const serviceDependencyRelations = relations(
	serviceDependency,
	({ one }) => ({
		dependsOn: one(service, {
			fields: [serviceDependency.dependsOnId],
			references: [service.id],
			relationName: "dependedOnBy",
		}),
		service: one(service, {
			fields: [serviceDependency.serviceId],
			references: [service.id],
			relationName: "dependencies",
		}),
	}),
);

export type UserRole = Role;
export const statusPage = pgTable(
	"status_page",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		description: text("description"),
		domains: jsonb("domains").$type<string[]>().default([]).notNull(),
		id: text("id").primaryKey(),
		isPublic: boolean("is_public").notNull().default(false),
		name: text("name").notNull(),
		stackId: text("stack_id").references(() => stack.id, {
			onDelete: "cascade",
		}),
		scope: text("scope").$type<StatusPageScope>().notNull(),
		slug: text("slug").notNull().unique(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("statusPage_userId_idx").on(table.userId)],
);

export const statusPageService = pgTable(
	"status_page_service",
	{
		id: text("id").primaryKey(),
		includeChildren: boolean("include_children").notNull().default(false),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		statusPageId: text("status_page_id")
			.notNull()
			.references(() => statusPage.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("statusPageService_pageId_serviceId_uidx").on(
			table.statusPageId,
			table.serviceId,
		),
		index("statusPageService_serviceId_idx").on(table.serviceId),
	],
);

export const notificationChannel = pgTable(
	"notification_channel",
	{
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		enabled: boolean("enabled").notNull().default(true),
		events: jsonb("events")
			.$type<NotificationEvent[]>()
			.notNull()
			.default([
				"build.failed",
				"build.checks_failed",
				"update.failed",
				"deploy.unhealthy",
				"deploy.rolled_back",
				"resource.warning",
				"resource.critical",
				"backup.failed",
				"cron_job.failed",
			]),
		groupMessages: boolean("group_messages").notNull().default(false),
		id: text("id").primaryKey(),
		kind: text("kind").$type<NotificationChannelKind>().notNull(),
		lastError: text("last_error"),
		name: text("name").notNull(),
		target: text("target").notNull(),
		updatedAt: timestamp("updated_at", { mode: "date" })
			.$onUpdate(() => new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("notificationChannel_userId_idx").on(table.userId)],
);

export const errorProject = pgTable("error_project", {
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	enabled: boolean("enabled").default(true).notNull(),
	id: text("id").primaryKey(),
	injectEnv: boolean("inject_env").default(true).notNull(),
	internalDsn: boolean("internal_dsn").default(true).notNull(),
	projectId: serial("project_id").notNull().unique(),
	publicKey: text("public_key").notNull().unique(),
	serviceId: text("service_id")
		.notNull()
		.unique()
		.references(() => service.id, { onDelete: "cascade" }),
});

export const nodeEnrollment = pgTable("node_enrollment", {
	buildServer: boolean("build_server").default(true).notNull(),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
	hostname: text("hostname"),
	id: text("id").primaryKey(),
	name: text("name"),
	remoteHostId: text("remote_host_id").references(() => remoteHost.id, {
		onDelete: "set null",
	}),
	swarmNode: boolean("swarm_node").default(false).notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	usedAt: timestamp("used_at", { mode: "date" }),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const dnsConnection = pgTable("dns_connection", {
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	credentials: jsonb("credentials")
		.$type<Record<string, string>>()
		.default({})
		.notNull(),
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	provider: text("provider").notNull(),
	updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const domain = pgTable("domain", {
	autoRecords: boolean("auto_records").default(true).notNull(),
	connectionId: text("connection_id").references(() => dnsConnection.id, {
		onDelete: "set null",
	}),
	createdAt: timestamp("created_at", { mode: "date" }).notNull(),
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	target: text("target"),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	zoneId: text("zone_id"),
	zoneName: text("zone_name"),
});

export const dnsManagedRecord = pgTable(
	"dns_managed_record",
	{
		content: text("content").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		domainId: text("domain_id")
			.notNull()
			.references(() => domain.id, { onDelete: "cascade" }),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		recordId: text("record_id").notNull(),
		type: text("type").notNull(),
	},
	(table) => [
		uniqueIndex("dnsManagedRecord_domain_name_type_uidx").on(
			table.domainId,
			table.name,
			table.type,
		),
	],
);

export const resourceIncident = pgTable(
	"resource_incident",
	{
		id: text("id").primaryKey(),
		kind: text("kind").$type<ResourceKind>().notNull(),
		lastNotifiedAt: timestamp("last_notified_at", { mode: "date" }).notNull(),
		level: text("level").$type<"hard" | "soft">().notNull(),
		notifications: integer("notifications").default(1).notNull(),
		peakPercent: integer("peak_percent").notNull(),
		resolvedAt: timestamp("resolved_at", { mode: "date" }),
		startedAt: timestamp("started_at", { mode: "date" }).notNull(),
	},
	(table) => [index("resourceIncident_startedAt_idx").on(table.startedAt)],
);

export const errorSourceMap = pgTable(
	"error_source_map",
	{
		content: text("content").notNull(),
		createdAt: timestamp("created_at", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		release: text("release").notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		sizeBytes: integer("size_bytes").notNull(),
	},
	(table) => [
		uniqueIndex("errorSourceMap_service_release_name_uidx").on(
			table.serviceId,
			table.release,
			table.name,
		),
	],
);

export const errorIssue = pgTable(
	"error_issue",
	{
		count: integer("count").default(0).notNull(),
		culprit: text("culprit"),
		fingerprint: text("fingerprint").notNull(),
		firstRelease: text("first_release"),
		firstSeen: timestamp("first_seen", { mode: "date" }).notNull(),
		id: text("id").primaryKey(),
		lastEnvironment: text("last_environment"),
		lastRelease: text("last_release"),
		lastSeen: timestamp("last_seen", { mode: "date" }).notNull(),
		level: text("level").default("error").notNull(),
		platform: text("platform"),
		regressedAt: timestamp("regressed_at", { mode: "date" }),
		resolvedAt: timestamp("resolved_at", { mode: "date" }),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		status: text("status")
			.$type<"unresolved" | "resolved" | "ignored">()
			.default("unresolved")
			.notNull(),
		title: text("title").notNull(),
		type: text("type"),
		value: text("value"),
	},
	(table) => [
		uniqueIndex("errorIssue_serviceId_fingerprint_uidx").on(
			table.serviceId,
			table.fingerprint,
		),
		index("errorIssue_serviceId_status_lastSeen_idx").on(
			table.serviceId,
			table.status,
			table.lastSeen,
		),
	],
);

export const traceSpan = pgTable(
	"trace_span",
	{
		attributes: jsonb("attributes")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		durationMs: doublePrecision("duration_ms").notNull(),
		endTime: timestamp("end_time", { mode: "date", precision: 3 }).notNull(),
		events: jsonb("events")
			.$type<
				{ attributes: Record<string, unknown>; name: string; time: string }[]
			>()
			.default([])
			.notNull(),
		id: serial("id").primaryKey(),
		kind: integer("kind").default(0).notNull(),
		name: text("name").notNull(),
		parentSpanId: text("parent_span_id"),
		resourceAttributes: jsonb("resource_attributes")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "cascade",
		}),
		serviceName: text("service_name").notNull(),
		spanId: text("span_id").notNull(),
		startTime: timestamp("start_time", {
			mode: "date",
			precision: 3,
		}).notNull(),
		statusCode: integer("status_code").default(0).notNull(),
		statusMessage: text("status_message"),
		traceId: text("trace_id").notNull(),
	},
	(table) => [
		uniqueIndex("traceSpan_traceId_spanId_idx").on(table.traceId, table.spanId),
		index("traceSpan_serviceId_startTime_idx").on(
			table.serviceId,
			table.startTime,
		),
		index("traceSpan_startTime_idx").on(table.startTime),
		index("traceSpan_jobId_idx")
			.on(sql`(${table.attributes} ->> 'homerun.job.id')`)
			.where(sql`${table.serviceId} is null`),
	],
);

export const errorEvent = pgTable(
	"error_event",
	{
		environment: text("environment"),
		eventId: text("event_id").notNull(),
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => errorIssue.id, { onDelete: "cascade" }),
		level: text("level").default("error").notNull(),
		message: text("message"),
		payload: jsonb("payload").$type<StoredErrorEvent>().notNull(),
		receivedAt: timestamp("received_at", { mode: "date" }).notNull(),
		release: text("release"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
		userKey: text("user_key"),
	},
	(table) => [
		uniqueIndex("errorEvent_serviceId_eventId_uidx").on(
			table.serviceId,
			table.eventId,
		),
		index("errorEvent_issueId_receivedAt_idx").on(
			table.issueId,
			table.receivedAt,
		),
		index("errorEvent_receivedAt_idx").on(table.receivedAt),
	],
);

export type Stack = typeof stack.$inferSelect;
export type OauthClient = typeof oauthClient.$inferSelect;
export type ErrorSourceMap = typeof errorSourceMap.$inferSelect;
export type ResourceIncident = typeof resourceIncident.$inferSelect;
export type DnsConnection = typeof dnsConnection.$inferSelect;
export type Domain = typeof domain.$inferSelect;
export type DnsManagedRecord = typeof dnsManagedRecord.$inferSelect;
export type OauthClientEnvironment = typeof oauthClientEnvironment.$inferSelect;
export type OauthClientSecret = typeof oauthClientSecret.$inferSelect;
export type Template = typeof template.$inferSelect;
export type TemplateLink = typeof templateLink.$inferSelect;
export type Service = typeof service.$inferSelect;
export type Deployment = typeof deployment.$inferSelect;
export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type StorageVolume = typeof storageVolume.$inferSelect;
export type S3Destination = typeof s3Destination.$inferSelect;
export type ServiceVolume = typeof serviceVolume.$inferSelect;
export type ServiceDependency = typeof serviceDependency.$inferSelect;
export type BackupRun = typeof backupRun.$inferSelect;
export type CronJob = typeof cronJob.$inferSelect;
export type CronJobRun = typeof cronJobRun.$inferSelect;
export type RemoteHost = typeof remoteHost.$inferSelect;
export type Workstation = typeof workstation.$inferSelect;
export type Redirect = typeof redirect.$inferSelect;
export type IpBan = typeof ipBan.$inferSelect;
export type BlockedHit = typeof blockedHit.$inferSelect;
export type BuildCacheRegistry = typeof buildCacheRegistry.$inferSelect;
export type RegistryToken = typeof registryToken.$inferSelect;
export type ObjectStore = typeof objectStore.$inferSelect;
export type TraceSpan = typeof traceSpan.$inferSelect;
export type PublicBucket = typeof publicBucket.$inferSelect;
export type IacProject = typeof iacProject.$inferSelect;
export type IacStateVersion = typeof iacStateVersion.$inferSelect;
export type IacStateLock = typeof iacStateLock.$inferSelect;
export type AppLog = typeof appLog.$inferSelect;
export type Notification = typeof notification.$inferSelect;
export type StatSample = typeof statSample.$inferSelect;
export type UptimeCheck = typeof uptimeCheck.$inferSelect;
export type StatusPage = typeof statusPage.$inferSelect;
export type StatusPageService = typeof statusPageService.$inferSelect;
export type NotificationChannel = typeof notificationChannel.$inferSelect;
export type Job = typeof job.$inferSelect;
export type ErrorProject = typeof errorProject.$inferSelect;
export type ErrorIssue = typeof errorIssue.$inferSelect;
export type ErrorEvent = typeof errorEvent.$inferSelect;
export type ImageScan = typeof imageScan.$inferSelect;
export type GitConnection = typeof gitConnection.$inferSelect;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type InvitationBase = typeof invitation.$inferSelect;
export type InvitationRefactored = Omit<InvitationBase, "role">;
export type Invitation = InvitationRefactored & {
	role: UserRole;
};
export type User = typeof user.$inferSelect;
export type NodeEnrollment = typeof nodeEnrollment.$inferSelect;
export type TrafficSample = typeof trafficSample.$inferSelect;

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id],
	}),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
	user: one(user, {
		fields: [passkey.userId],
		references: [user.id],
	}),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
	user: one(user, {
		fields: [twoFactor.userId],
		references: [user.id],
	}),
}));
