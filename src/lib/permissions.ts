export const PERMISSION_LEVELS = ["read", "write"] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_AREAS = [
	{
		description: "Services, deployments, previews, logs and monitoring.",
		key: "services",
		label: "Services",
		routes: [
			"/services",
			"/deployments",
			"/monitoring",
			"/api/v1/monitoring",
			"/api/v1/services",
			"/api/v1/service-environments",
			"/api/v1/service-dependencies",
			"/api/v1/volume-mounts",
		],
	},
	{
		description:
			"Your own dev workstations: browser IDE containers on this server or an agent host.",
		key: "workstations",
		label: "Workstations",
		routes: [
			"/workstations",
			"/api/v1/workstations",
			"/api/v1/workstation-presets",
		],
	},
	{
		description: "Stacks and compose imports into them.",
		key: "stacks",
		label: "Stacks",
		routes: ["/stacks", "/api/v1/stacks"],
	},
	{
		description: "Service templates and their links.",
		key: "templates",
		label: "Templates",
		routes: ["/templates", "/api/v1/templates"],
	},
	{
		description:
			"Scheduled jobs. Host command jobs also need write access to System.",
		key: "cron-jobs",
		label: "Cron jobs",
		routes: ["/cron-jobs", "/api/v1/cron-jobs"],
	},
	{
		description: "Hostname and path redirects.",
		key: "redirects",
		label: "Redirects",
		routes: ["/redirects", "/api/v1/redirects"],
	},
	{
		description: "Public status pages.",
		key: "status-pages",
		label: "Status pages",
		routes: ["/status-pages", "/api/v1/status-pages"],
	},
	{
		description: "Volumes, backups and backup destinations.",
		key: "storage",
		label: "Volumes & backups",
		routes: [
			"/storage",
			"/backups",
			"/s3-destinations",
			"/api/v1/volumes",
			"/api/v1/backups",
			"/api/v1/backup-destinations",
		],
	},
	{
		description: "Object stores, their buckets and IaC state storage.",
		key: "object-storage",
		label: "Object storage",
		routes: ["/object-storage", "/api/v1/object-stores"],
	},
	{
		description: "The built-in image registry, its images and tokens.",
		key: "registry",
		label: "Docker Registry",
		routes: ["/registry", "/api/v1/registry"],
	},
	{
		description: "Registries that cache image builds.",
		key: "build-cache",
		label: "Build cache",
		routes: ["/build-cache-registries", "/api/v1/build-cache-registries"],
	},
	{
		description: "GitHub, GitLab and other git provider connections.",
		key: "git-providers",
		label: "Git providers",
		routes: ["/git-providers", "/api/v1/git-providers"],
	},
	{
		description: "Channels alerts and deploy notifications are sent to.",
		key: "notifications",
		label: "Notification channels",
		routes: [
			"/notifications/settings/channels",
			"/api/v1/notification-channels",
		],
	},
	{
		description: "DNS provider connections and managed records.",
		key: "dns",
		label: "DNS",
		routes: ["/dns", "/api/v1/dns-connections", "/api/v1/domains"],
	},
	{
		description: "Remote build and swarm hosts, and service scheduling.",
		key: "remote-hosts",
		label: "Remote hosts",
		routes: ["/remote-hosts", "/scheduling", "/api/v1/remote-hosts"],
	},
	{
		description:
			"Root on the box: the host terminal, system logs, Docker cleanup, host command cron jobs and host-level service options.",
		key: "system",
		label: "System",
		routes: [
			"/terminal",
			"/system-logs",
			"/docker-cleanup",
			"/api/v1/jobs",
			"/api/v1/system",
		],
	},
	{
		description: "IaC projects, their state and code generation.",
		key: "iac",
		label: "Infrastructure as code",
		routes: ["/iac", "/api/v1/iac"],
	},
	{
		description:
			"Users, invites, sign-in providers and Homerun's OIDC apps. Write access can grant any permission, its holder's own included.",
		key: "users",
		label: "Users & authentication",
		routes: [
			"/users",
			"/service-accounts",
			"/authentication",
			"/idp",
			"/api/v1/service-accounts",
			"/api/v1/authentication",
			"/api/v1/users",
			"/api/v1/oauth-providers",
			"/api/v1/oidc-apps",
		],
	},
	{
		description:
			"Instance settings: domains, TLS, email, Docker, networking and updates.",
		key: "settings",
		label: "Settings",
		routes: ["/settings", "/api/v1/instance"],
	},
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number]["key"];

export type Permissions = Partial<Record<PermissionArea, PermissionLevel>>;

const AREA_KEYS: PermissionArea[] = PERMISSION_AREAS.map((area) => area.key);

const OPEN_ROUTES = [
	"/",
	"/notifications",
	"/profile",
	"/cli-auth",
	"/api-docs",
	"/api/v1/auth",
	"/api/v1/auth-check",
	"/api/v1/auth-token",
	"/api/v1/mcp",
	"/api/v1/nodes",
	"/api/v1/notifications",
	"/api/v1/manifest.schema.json",
	"/api/v1/manifests",
	"/api/v1/openapi.json",
	"/api/v1/otlp",
	"/api/v1/ready",
	"/api/v1/system-stats",
	"/api/v1/webhooks",
];

const PROTECTED_GROUP = "/(protected)";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const USER_ROLES = [
	"admin",
	"developer",
	"viewer",
	"app-user",
	"custom",
] as const;

export type Role = (typeof USER_ROLES)[number];

export const APP_ONLY_ROLE: Role = "app-user";

export const CUSTOM_ROLE: Role = "custom";

export const ROLE_OPTIONS: {
	description: string;
	label: string;
	value: Role;
}[] = [
	{
		description: "The whole dashboard, except Users and Settings.",
		label: "Developer",
		value: "developer",
	},
	{
		description: "Sees what a developer sees but can't change anything.",
		label: "Read-only",
		value: "viewer",
	},
	{
		description:
			"No dashboard at all: only signs in to the apps whose login wall lets them through.",
		label: "App access only",
		value: "app-user",
	},
	{
		description: "Exactly the areas you pick, each read-only or read-write.",
		label: "Custom",
		value: "custom",
	},
	{
		description: "Everything, including Users and Settings.",
		label: "Admin",
		value: "admin",
	},
];

const DEVELOPER_PERMISSIONS: Permissions = {
	"build-cache": "write",
	"cron-jobs": "write",
	"git-providers": "read",
	notifications: "write",
	redirects: "write",
	"remote-hosts": "read",
	services: "write",
	stacks: "write",
	"status-pages": "write",
	storage: "write",
	templates: "write",
	workstations: "write",
};

export interface PermissionPreset {
	description: string;
	id: string;
	label: string;
	permissions: Permissions;
}

export const PERMISSION_PRESETS: PermissionPreset[] = [
	{
		description: "Sees every area, changes nothing.",
		id: "read-only",
		label: "Read-only",
		permissions: allPermissions("read"),
	},
	{
		description:
			"What the Developer role holds: the dashboard minus Users and Settings.",
		id: "developer",
		label: "Developer",
		permissions: DEVELOPER_PERMISSIONS,
	},
	{
		description:
			"A CI pipeline: pushes to the built-in registry and deploys services.",
		id: "ci",
		label: "CI deploys",
		permissions: { registry: "write", services: "write", stacks: "read" },
	},
	{
		description: "Everything the Terraform provider manages, plus IaC state.",
		id: "iac",
		label: "Infrastructure as code",
		permissions: {
			"build-cache": "write",
			"cron-jobs": "write",
			dns: "write",
			"git-providers": "write",
			iac: "write",
			notifications: "write",
			"object-storage": "write",
			redirects: "write",
			"remote-hosts": "write",
			services: "write",
			stacks: "write",
			"status-pages": "write",
			storage: "write",
			templates: "read",
			workstations: "write",
		},
	},
];

/** Whether two permission sets grant exactly the same areas at the same levels. */
export function samePermissions(
	first: Permissions,
	second: Permissions,
): boolean {
	const areas = new Set([...Object.keys(first), ...Object.keys(second)]);
	return [...areas].every(
		(area) => first[area as PermissionArea] === second[area as PermissionArea],
	);
}

export const API_KEY_EXPIRY_OPTIONS = [
	{ days: 7, label: "7 days", value: "7" },
	{ days: 30, label: "30 days", value: "30" },
	{ days: 90, label: "90 days (recommended)", value: "90" },
	{ days: 365, label: "1 year", value: "365" },
	{ days: null, label: "Never", value: "never" },
] as const;

export type ApiKeyExpiry = (typeof API_KEY_EXPIRY_OPTIONS)[number]["value"];

export const DEFAULT_API_KEY_EXPIRY: ApiKeyExpiry = "90";

export const APP_ONLY_MESSAGE =
	"This account can only sign in to the apps shared with it, not the Homerun dashboard.";

export const APP_ONLY_HOME = "/my-apps";

const APP_ONLY_API_PREFIXES = ["/api/v1/auth/", "/api/health", "/api/v1/ready"];

const APP_ONLY_DENIED_AUTH_PREFIXES = [
	"/api/v1/auth/api-key/",
	"/api/v1/auth/admin/",
	"/api/v1/auth/cli/",
];

const APP_ONLY_REMOTE_COMMANDS = new Set([
	"completeAccountSetup",
	"lookupSignIn",
	"resendSetupCode",
]);

const APP_ONLY_DENIED_ROUTES = ["/(protected)", "/onboarding"];

const REMOTE_PREFIX = "/_app/remote/";

/**
 * A role in the shape better-auth's admin plugin endpoints are typed with. The
 * plugin types roles as its own defaults ("user" | "admin") because this app
 * doesn't register an access-control role map, but it stores whatever string
 * it's given, so every role here is passed through unchanged.
 */
export function asAuthRole(role: Role): "admin" | "user" {
	return role as "admin" | "user";
}

/** Whether `role` is a role this app knows about. */
export function isUserRole(role: unknown): role is Role {
	return typeof role === "string" && USER_ROLES.includes(role as Role);
}

/** The display label for a stored role, falling back to Developer for an unset one. */
export function roleLabel(role: string | null | undefined): string {
	return (
		ROLE_OPTIONS.find((option) => option.value === role)?.label ?? "Developer"
	);
}

/** Whether a user holds the app-access-only role: login-wall apps only, never the dashboard. */
export function isAppOnly(role: string | null | undefined): boolean {
	return role === APP_ONLY_ROLE;
}

/** The display label of a permission area. */
export function areaLabel(area: PermissionArea): string {
	return PERMISSION_AREAS.find((entry) => entry.key === area)?.label ?? area;
}

/** Whether `permissions` grants `level` on `area`; write access includes read. */
export function can(
	permissions: Permissions,
	area: PermissionArea,
	level: PermissionLevel = "read",
): boolean {
	const granted = permissions[area];
	return granted === "write" || (granted === "read" && level === "read");
}

/** Every area at `level`. */
export function allPermissions(level: PermissionLevel = "write"): Permissions {
	return Object.fromEntries(AREA_KEYS.map((area) => [area, level]));
}

/** Whether `permissions` grants write access to every area, which is what an admin holds. */
export function hasAllPermissions(permissions: Permissions): boolean {
	return AREA_KEYS.every((area) => permissions[area] === "write");
}

/** Whether `permissions` grants write access to at least one area. */
export function hasAnyWrite(permissions: Permissions): boolean {
	return AREA_KEYS.some((area) => permissions[area] === "write");
}

/**
 * Permissions read from untrusted input (a jsonb column, a better-auth API
 * key's permissions record, a form): unknown areas and levels are dropped. A
 * level may be a bare string or better-auth's array shape, whose highest level
 * wins.
 */
export function parsePermissions(value: unknown): Permissions {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const parsed: Permissions = {};
	for (const area of AREA_KEYS) {
		const raw = (value as Record<string, unknown>)[area];
		const levels = Array.isArray(raw) ? raw : [raw];
		if (levels.includes("write")) {
			parsed[area] = "write";
		} else if (levels.includes("read")) {
			parsed[area] = "read";
		}
	}
	return parsed;
}

/** Permissions in the record shape better-auth stores on an API key. */
export function toApiKeyPermissions(
	permissions: Permissions,
): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(permissions).map(([area, level]) => [area, [level]]),
	);
}

/** The lower of the two grants on every area: what a scoped API key can do on its owner's behalf. */
export function intersectPermissions(
	first: Permissions,
	second: Permissions,
): Permissions {
	const result: Permissions = {};
	for (const area of AREA_KEYS) {
		if (can(first, area, "write") && can(second, area, "write")) {
			result[area] = "write";
		} else if (can(first, area) && can(second, area)) {
			result[area] = "read";
		}
	}
	return result;
}

/** What a user holds: their role's preset, or their own stored permissions for the custom role. */
export function permissionsForRole(
	role: string | null | undefined,
	stored: unknown,
): Permissions {
	switch (role) {
		case "admin":
			return allPermissions("write");
		case "viewer":
			return Object.fromEntries(
				Object.keys(DEVELOPER_PERMISSIONS).map((area) => [area, "read"]),
			);
		case "app-user":
			return {};
		case "custom":
			return parsePermissions(stored);
		default:
			return { ...DEVELOPER_PERMISSIONS };
	}
}

/**
 * The permissions a form posted as one `permission.<area>` field per area,
 * each `read`, `write` or anything else for no access.
 */
export function permissionsFromForm(formData: FormData): Permissions {
	return parsePermissions(
		Object.fromEntries(
			AREA_KEYS.map((area) => [area, formData.get(`permission.${area}`)]),
		),
	);
}

/** Whether `routeId` is `prefix` or a route below it. */
function routeWithin(routeId: string, prefix: string): boolean {
	return (
		routeId === prefix || (prefix !== "/" && routeId.startsWith(`${prefix}/`))
	);
}

/**
 * The permission a request needs, from SvelteKit's matched route: the area
 * owning the route at `read` for a safe method and `write` otherwise, even
 * under an open route (notification channels sit under the open
 * `/notifications`). Null when no area claims a route open to every signed-in
 * user (their own profile, the overview, better-auth) or one that sits outside the dashboard and the REST API,
 * which guard themselves; `"unmapped"` for a dashboard or API route no area
 * claims, which only a holder of every permission may reach.
 */
export function requiredPermission(
	method: string,
	routeId: string | null,
): { area: PermissionArea; level: PermissionLevel } | null | "unmapped" {
	if (!routeId) {
		return null;
	}
	const inDashboard = routeWithin(routeId, PROTECTED_GROUP);
	if (!(inDashboard || routeWithin(routeId, "/api/v1"))) {
		return null;
	}
	const id = inDashboard
		? routeId.slice(PROTECTED_GROUP.length) || "/"
		: routeId;
	const area = PERMISSION_AREAS.find((entry) =>
		entry.routes.some((prefix: string) => routeWithin(id, prefix)),
	);
	if (!area) {
		return OPEN_ROUTES.some((prefix) => routeWithin(id, prefix))
			? null
			: "unmapped";
	}
	return {
		area: area.key,
		level: SAFE_METHODS.has(method.toUpperCase()) ? "read" : "write",
	};
}

/**
 * Whether `permissions` may open a dashboard link, from the area owning its
 * path: the sidebar, global search's pages and its results all hide what the
 * viewer can't open.
 */
export function mayVisit(permissions: Permissions, href: string): boolean {
	const pathname = href.split(/[?#]/)[0] || "/";
	const required = requiredPermission(
		"GET",
		pathname === "/" ? PROTECTED_GROUP : `${PROTECTED_GROUP}${pathname}`,
	);
	if (required === "unmapped") {
		return hasAllPermissions(permissions);
	}
	return !required || can(permissions, required.area, required.level);
}

/** The message a caller missing `level` access to `area` is refused with. */
export function permissionDeniedMessage(
	area: PermissionArea,
	level: PermissionLevel,
): string {
	return level === "write"
		? `You don't have permission to change ${areaLabel(area)}.`
		: `You don't have permission to view ${areaLabel(area)}.`;
}

/**
 * Whether an app-access-only user may make this request, whatever its method:
 * their own account's better-auth endpoints (sign-in and out, password,
 * passkeys, 2FA, sessions, Homerun's own OIDC authorize and consent) minus API
 * keys, the admin plugin and CLI login; the sign-in page's remote
 * commands; and every page outside the dashboard (`(protected)`) and
 * onboarding. `routeId` is SvelteKit's matched route, null for a 404.
 */
export function appOnlyMayRequest(
	pathname: string,
	routeId: string | null,
): boolean {
	if (pathname.startsWith(REMOTE_PREFIX)) {
		const name = pathname.slice(REMOTE_PREFIX.length).split("/")[1] ?? "";
		return APP_ONLY_REMOTE_COMMANDS.has(name);
	}
	if (pathname.startsWith("/api/")) {
		return (
			APP_ONLY_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
			!APP_ONLY_DENIED_AUTH_PREFIXES.some((prefix) =>
				pathname.startsWith(prefix),
			)
		);
	}
	return !(
		routeId &&
		APP_ONLY_DENIED_ROUTES.some(
			(denied) => routeId === denied || routeId.startsWith(`${denied}/`),
		)
	);
}
