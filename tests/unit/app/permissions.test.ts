import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "devalue";
import {
	APP_ONLY_HOME,
	APP_ONLY_MESSAGE,
	allPermissions,
	appOnlyMayRequest,
	can,
	hasAllPermissions,
	hasAnyWrite,
	intersectPermissions,
	isAppOnly,
	isUserRole,
	mayVisit,
	PERMISSION_AREAS,
	PERMISSION_PRESETS,
	parsePermissions,
	permissionDeniedMessage,
	permissionsForRole,
	permissionsFromForm,
	requiredPermission,
	roleLabel,
	samePermissions,
	toApiKeyPermissions,
} from "../../../src/lib/permissions";
import {
	appOnlyRejection,
	permissionRejection,
	serviceAccountRejection,
} from "../../../src/lib/server/access-gate";

function request(method: string, headers: Record<string, string> = {}) {
	return { headers: new Headers(headers), method };
}

function routeIds(directory: string): string[] {
	const ids = new Set<string>();
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (
				/^\+(page|layout|server)(\.server)?\.(ts|svelte)$/.test(entry.name)
			) {
				ids.add(`/${relative("src/routes", current)}`.replace(/\/$/, ""));
			}
		}
	};
	walk(directory);
	return [...ids];
}

describe("roles", () => {
	test("knows the five roles and labels them", () => {
		expect(isUserRole("admin")).toBe(true);
		expect(isUserRole("developer")).toBe(true);
		expect(isUserRole("viewer")).toBe(true);
		expect(isUserRole("app-user")).toBe(true);
		expect(isUserRole("custom")).toBe(true);
		expect(isUserRole("user")).toBe(false);
		expect(isUserRole(null)).toBe(false);
		expect(roleLabel("app-user")).toBe("App access only");
		expect(roleLabel("viewer")).toBe("Read-only");
		expect(roleLabel("custom")).toBe("Custom");
		expect(roleLabel(null)).toBe("Developer");
	});

	test("maps each preset role to its permissions", () => {
		expect(hasAllPermissions(permissionsForRole("admin", null))).toBe(true);
		const developer = permissionsForRole("developer", null);
		expect(can(developer, "services", "write")).toBe(true);
		expect(can(developer, "git-providers", "read")).toBe(true);
		expect(can(developer, "git-providers", "write")).toBe(false);
		expect(can(developer, "settings")).toBe(false);
		expect(can(developer, "system")).toBe(false);
		expect(permissionsForRole(null, null)).toEqual(developer);
		const viewer = permissionsForRole("viewer", null);
		expect(can(viewer, "services")).toBe(true);
		expect(hasAnyWrite(viewer)).toBe(false);
		expect(can(viewer, "users")).toBe(false);
		expect(permissionsForRole("app-user", null)).toEqual({});
	});

	test("reads a custom role's stored permissions and ignores them for presets", () => {
		const stored = { services: "write", settings: "read" };
		expect(permissionsForRole("custom", stored)).toEqual({
			services: "write",
			settings: "read",
		});
		expect(can(permissionsForRole("developer", stored), "settings")).toBe(
			false,
		);
		expect(permissionsForRole("custom", null)).toEqual({});
	});
});

describe("permission sets", () => {
	test("write includes read, read doesn't include write", () => {
		expect(can({ services: "write" }, "services", "read")).toBe(true);
		expect(can({ services: "read" }, "services", "write")).toBe(false);
		expect(can({}, "services")).toBe(false);
	});

	test("parses untrusted shapes and drops what it doesn't know", () => {
		expect(
			parsePermissions({
				bogus: "write",
				services: ["read", "write"],
				settings: "admin",
				stacks: ["read"],
				users: "read",
			}),
		).toEqual({ services: "write", stacks: "read", users: "read" });
		expect(parsePermissions(null)).toEqual({});
		expect(parsePermissions("services")).toEqual({});
		expect(parsePermissions(["services"])).toEqual({});
	});

	test("round-trips through better-auth's API key shape", () => {
		const permissions = { services: "write", stacks: "read" } as const;
		expect(parsePermissions(toApiKeyPermissions(permissions))).toEqual(
			permissions,
		);
	});

	test("intersects a key's permissions with its owner's", () => {
		expect(
			intersectPermissions(
				{ services: "write", settings: "write", stacks: "read" },
				{ services: "read", settings: "write", users: "write" },
			),
		).toEqual({ services: "read", settings: "write" });
		expect(intersectPermissions(allPermissions("write"), {})).toEqual({});
	});

	test("reads one field per area from a form", () => {
		const form = new FormData();
		form.set("permission.services", "write");
		form.set("permission.stacks", "read");
		form.set("permission.settings", "none");
		form.set("permission.nope", "write");
		expect(permissionsFromForm(form)).toEqual({
			services: "write",
			stacks: "read",
		});
	});
});

describe("requiredPermission", () => {
	test("maps dashboard and API routes to their area by method", () => {
		expect(
			requiredPermission("GET", "/(protected)/services/[serviceId]/logs"),
		).toEqual({ area: "services", level: "read" });
		expect(requiredPermission("POST", "/(protected)/settings/tls")).toEqual({
			area: "settings",
			level: "write",
		});
		expect(requiredPermission("DELETE", "/api/v1/stacks/[stackId]")).toEqual({
			area: "stacks",
			level: "write",
		});
		expect(requiredPermission("HEAD", "/api/v1/volumes")).toEqual({
			area: "storage",
			level: "read",
		});
	});

	test("leaves open routes and routes outside the dashboard alone", () => {
		expect(requiredPermission("GET", "/(protected)")).toBeNull();
		expect(
			requiredPermission("POST", "/(protected)/profile/clients"),
		).toBeNull();
		expect(requiredPermission("POST", "/api/v1/mcp")).toBeNull();
		expect(requiredPermission("POST", "/onboarding")).toBeNull();
		expect(requiredPermission("GET", null)).toBeNull();
	});

	test("doesn't let a prefix match a longer sibling", () => {
		expect(requiredPermission("GET", "/(protected)/servicesx")).toBe(
			"unmapped",
		);
		expect(requiredPermission("GET", "/api/v1/service-environments")).toEqual({
			area: "services",
			level: "read",
		});
	});

	test("maps every dashboard and REST API route to an area or an open route", () => {
		const unmapped = [
			...routeIds("src/routes/(protected)"),
			...routeIds("src/routes/api/v1"),
		].filter((id) => requiredPermission("GET", id) === "unmapped");
		expect(unmapped).toEqual([]);
	});
});

describe("mayVisit", () => {
	test("hides links to areas the viewer can't read", () => {
		const developer = permissionsForRole("developer", null);
		expect(mayVisit(developer, "/services/abc?tab=logs")).toBe(true);
		expect(mayVisit(developer, "/settings")).toBe(false);
		expect(mayVisit(developer, "/")).toBe(true);
		expect(mayVisit(developer, "/profile/clients")).toBe(true);
		expect(mayVisit({}, "/nowhere")).toBe(false);
		expect(mayVisit(allPermissions("write"), "/nowhere")).toBe(true);
	});
});

describe("permissionRejection", () => {
	const developer = permissionsForRole("developer", null);

	test("allows what the permissions cover", () => {
		expect(
			permissionRejection(
				request("POST"),
				"/api/v1/services",
				{ id: "/api/v1/services", isEndpoint: true },
				developer,
			),
		).toBeNull();
	});

	test("answers a use:enhance form with an ActionResult failure", async () => {
		const response = permissionRejection(
			request("POST", { "x-sveltekit-action": "true" }),
			"/settings",
			{ id: "/(protected)/settings", isEndpoint: false },
			developer,
		);
		const body = (await response?.json()) as { data: string; status: number };
		expect(body.status).toBe(403);
		expect(parse(body.data)).toEqual({
			error: permissionDeniedMessage("settings", "write"),
		});
	});

	test("answers the REST API with a JSON 403, reads included", async () => {
		const response = permissionRejection(
			request("GET"),
			"/api/v1/iac/projects",
			{ id: "/api/v1/iac/projects", isEndpoint: true },
			developer,
		);
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({
			error: permissionDeniedMessage("iac", "read"),
		});
	});

	test("refuses a dashboard endpoint's reads itself", () => {
		expect(
			permissionRejection(
				request("GET"),
				"/iac/download",
				{ id: "/(protected)/iac/download", isEndpoint: true },
				developer,
			)?.status,
		).toBe(403);
	});

	test("leaves dashboard page reads to the layout", () => {
		expect(
			permissionRejection(
				request("GET"),
				"/settings",
				{ id: "/(protected)/settings", isEndpoint: false },
				developer,
			),
		).toBeNull();
	});

	test("refuses a write a read-only key can't make", () => {
		const readOnly = intersectPermissions(
			allPermissions("write"),
			allPermissions("read"),
		);
		expect(
			permissionRejection(
				request("DELETE"),
				"/api/v1/services/abc",
				{ id: "/api/v1/services/[serviceId]", isEndpoint: true },
				readOnly,
			)?.status,
		).toBe(403);
	});

	test("refuses an unmapped route to everyone but a holder of every permission", () => {
		expect(
			permissionRejection(
				request("GET"),
				"/api/v1/brand-new",
				{ id: "/api/v1/brand-new", isEndpoint: true },
				developer,
			)?.status,
		).toBe(403);
		expect(
			permissionRejection(
				request("GET"),
				"/api/v1/brand-new",
				{ id: "/api/v1/brand-new", isEndpoint: true },
				allPermissions("write"),
			),
		).toBeNull();
	});
});

describe("isAppOnly", () => {
	test("is true only for the app-access-only role", () => {
		expect(isAppOnly("app-user")).toBe(true);
		expect(isAppOnly("viewer")).toBe(false);
		expect(isAppOnly("admin")).toBe(false);
		expect(isAppOnly(null)).toBe(false);
	});
});

describe("appOnlyMayRequest", () => {
	test("refuses every dashboard page, reads included", () => {
		expect(appOnlyMayRequest("/", "/(protected)")).toBe(false);
		expect(
			appOnlyMayRequest("/services/abc", "/(protected)/services/[serviceId]"),
		).toBe(false);
		expect(
			appOnlyMayRequest("/profile/clients", "/(protected)/profile/clients"),
		).toBe(false);
		expect(appOnlyMayRequest("/cli-auth", "/(protected)/cli-auth")).toBe(false);
		expect(appOnlyMayRequest("/onboarding", "/onboarding")).toBe(false);
	});

	test("allows the sign-in, login wall, security setup and apps pages", () => {
		expect(appOnlyMayRequest("/auth/sign-in", "/auth/sign-in")).toBe(true);
		expect(appOnlyMayRequest("/auth/consent", "/auth/consent")).toBe(true);
		expect(appOnlyMayRequest("/app-auth", "/app-auth")).toBe(true);
		expect(appOnlyMayRequest("/security-setup", "/security-setup")).toBe(true);
		expect(appOnlyMayRequest("/my-apps", "/my-apps")).toBe(true);
		expect(appOnlyMayRequest("/nowhere", null)).toBe(true);
	});

	test("refuses the REST API and MCP but keeps their own account endpoints", () => {
		expect(appOnlyMayRequest("/api/v1/services", null)).toBe(false);
		expect(appOnlyMayRequest("/api/v1/mcp", null)).toBe(false);
		expect(appOnlyMayRequest("/api/v1/auth-token", null)).toBe(false);
		expect(appOnlyMayRequest("/api/v1/auth/sign-out", null)).toBe(true);
		expect(appOnlyMayRequest("/api/v1/auth/passkey/add-passkey", null)).toBe(
			true,
		);
		expect(appOnlyMayRequest("/api/v1/auth/oauth2/authorize", null)).toBe(true);
		expect(appOnlyMayRequest("/api/v1/ready", null)).toBe(true);
	});

	test("refuses API keys, the admin plugin and CLI login", () => {
		expect(appOnlyMayRequest("/api/v1/auth/api-key/create", null)).toBe(false);
		expect(appOnlyMayRequest("/api/v1/auth/admin/set-role", null)).toBe(false);
		expect(appOnlyMayRequest("/api/v1/auth/cli/device", null)).toBe(false);
	});

	test("allows only the sign-in page's remote commands", () => {
		expect(appOnlyMayRequest("/_app/remote/abc/lookupSignIn", null)).toBe(true);
		expect(
			appOnlyMayRequest("/_app/remote/abc/markNotificationRead", null),
		).toBe(false);
		expect(appOnlyMayRequest("/_app/remote/abc/getSystemStats", null)).toBe(
			false,
		);
	});
});

describe("appOnlyRejection", () => {
	test("returns null for an allowed request", () => {
		expect(
			appOnlyRejection(request("GET"), "/my-apps", "/my-apps", false),
		).toBeNull();
	});

	test("sends a dashboard page load to the apps page", () => {
		const response = appOnlyRejection(
			request("GET"),
			"/services",
			"/(protected)/services",
			false,
		);
		expect(response?.status).toBe(303);
		expect(response?.headers.get("location")).toBe(APP_ONLY_HOME);
	});

	test("answers a client-side navigation with SvelteKit's JSON redirect", async () => {
		const response = appOnlyRejection(
			request("GET"),
			"/",
			"/(protected)",
			true,
		);
		expect(await response?.json()).toEqual({
			location: APP_ONLY_HOME,
			type: "redirect",
		});
	});

	test("refuses a form action, the REST API and remote functions with a 403", async () => {
		const action = appOnlyRejection(
			request("POST", { "x-sveltekit-action": "true" }),
			"/users",
			"/(protected)/users",
			false,
		);
		const body = (await action?.json()) as { data: string; status: number };
		expect(body.status).toBe(403);
		expect(parse(body.data)).toEqual({ error: APP_ONLY_MESSAGE });

		const api = appOnlyRejection(
			request("GET"),
			"/api/v1/services",
			null,
			false,
		);
		expect(api?.status).toBe(403);
		expect(await api?.json()).toEqual({ error: APP_ONLY_MESSAGE });

		const remote = appOnlyRejection(
			request("GET"),
			"/_app/remote/abc/getSystemStats",
			null,
			false,
		);
		expect(remote?.status).toBe(403);
	});

	test("refuses a plain write to a dashboard page with text", async () => {
		const response = appOnlyRejection(
			request("POST"),
			"/services",
			"/(protected)/services",
			false,
		);
		expect(response?.status).toBe(403);
		expect(await response?.text()).toBe(APP_ONLY_MESSAGE);
	});
});

describe("PERMISSION_PRESETS", () => {
	test("only name real areas, and Developer matches the role", () => {
		const areas = new Set(PERMISSION_AREAS.map((area) => area.key));
		for (const preset of PERMISSION_PRESETS) {
			for (const area of Object.keys(preset.permissions)) {
				expect(areas.has(area as never)).toBe(true);
			}
		}
		const developer = PERMISSION_PRESETS.find(
			(preset) => preset.id === "developer",
		);
		expect(
			samePermissions(
				developer?.permissions ?? {},
				permissionsForRole("developer", null),
			),
		).toBe(true);
	});
});

describe("samePermissions", () => {
	test("compares every area and level both ways", () => {
		expect(samePermissions({}, {})).toBe(true);
		expect(samePermissions({ services: "write" }, { services: "write" })).toBe(
			true,
		);
		expect(samePermissions({ services: "write" }, { services: "read" })).toBe(
			false,
		);
		expect(samePermissions({ services: "read" }, {})).toBe(false);
		expect(samePermissions({}, { dns: "read" })).toBe(false);
	});
});

describe("serviceAccountRejection", () => {
	test("lets an ungranted account through /app-auth only", async () => {
		expect(
			serviceAccountRejection(request("GET"), "/app-auth", "/app-auth", {}),
		).toBeNull();
		for (const [pathname, routeId] of [
			["/api/v1/services", "/api/v1/services"],
			["/api/v1/notifications", "/api/v1/notifications"],
			["/api/v1/mcp", "/api/v1/mcp"],
			["/profile", "/(protected)/profile"],
			["/my-apps", "/my-apps"],
			["/nowhere", null],
		] as const) {
			const response = serviceAccountRejection(
				request("GET"),
				pathname,
				routeId,
				{},
			);
			expect(response?.status).toBe(403);
		}
	});

	test("opens the areas it was granted and leaves the level to permissionRejection", () => {
		expect(
			serviceAccountRejection(
				request("POST"),
				"/api/v1/services",
				"/api/v1/services",
				{ services: "read" },
			),
		).toBeNull();
		expect(
			serviceAccountRejection(
				request("GET"),
				"/api/v1/stacks",
				"/api/v1/stacks",
				{ services: "read" },
			)?.status,
		).toBe(403);
	});
});
