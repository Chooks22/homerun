import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseBuiltinTemplates } from "#lib/server/db/builtin-templates.js";
import {
	currentHref,
	DEFAULT_UI_MODE,
	effectiveUiMode,
	isUiMode,
	SIMPLE_FRONT_PAGE_TEMPLATES,
	UI_MODE_DESCRIPTIONS,
	UI_MODE_LABELS,
	UI_MODES,
	visibleIn,
	visibleItems,
} from "#lib/ui-mode.js";

describe("effectiveUiMode", () => {
	test("the account's own choice wins", () => {
		expect(effectiveUiMode("simple", "advanced")).toBe("simple");
		expect(effectiveUiMode("advanced", "simple")).toBe("advanced");
	});

	test("an account with no choice follows the instance default", () => {
		expect(effectiveUiMode(null, "simple")).toBe("simple");
		expect(effectiveUiMode(undefined, "advanced")).toBe("advanced");
	});

	test("an instance that never picked one stays advanced", () => {
		expect(DEFAULT_UI_MODE).toBe("advanced");
		expect(effectiveUiMode(null, null)).toBe("advanced");
		expect(effectiveUiMode(undefined, undefined)).toBe("advanced");
	});
});

describe("isUiMode", () => {
	test("accepts the two modes only", () => {
		expect(isUiMode("simple")).toBe(true);
		expect(isUiMode("advanced")).toBe(true);
		expect(isUiMode("")).toBe(false);
		expect(isUiMode("Simple")).toBe(false);
		expect(isUiMode(null)).toBe(false);
	});

	test("every mode has a label and a description", () => {
		for (const mode of UI_MODES) {
			expect(UI_MODE_LABELS[mode]).toBeTruthy();
			expect(UI_MODE_DESCRIPTIONS[mode]).toBeTruthy();
		}
	});
});

describe("visibleIn", () => {
	test("advanced mode shows everything", () => {
		for (const id of ["/registry", "service/observability/traces", "x"]) {
			expect(visibleIn("advanced", id)).toBe(true);
		}
	});

	test("simple mode hides the engineering features", () => {
		for (const id of [
			"/deployments",
			"/remote-hosts",
			"/scheduling",
			"/build-cache-registries",
			"/registry",
			"/object-storage",
			"/iac",
			"/idp",
			"/api-docs",
			"/terminal",
			"/docker-cleanup",
			"/system-logs",
			"service/environments/environments",
			"service/environments/revisions",
			"service/environments/previews",
			"service/environments/channels",
			"service/observability/errors",
			"service/observability/traces",
			"service/container/runtime",
			"service/networking#published-ports",
			"service/security#blocked-paths",
			"settings/ip-bans",
			"monitoring/traces",
			"monitoring/settings",
		]) {
			expect(visibleIn("simple", id)).toBe(false);
		}
	});

	test("simple mode keeps the homelab essentials", () => {
		for (const id of [
			"/",
			"/services",
			"/monitoring",
			"/stacks",
			"/templates",
			"/storage",
			"/backups",
			"/s3-destinations",
			"/status-pages",
			"/cron-jobs",
			"/redirects",
			"/dns",
			"/git-providers",
			"/users",
			"/authentication",
			"/settings",
			"service/environments/source",
			"service/environments/variables",
			"service/observability/monitoring",
			"service/observability/events",
			"service/observability/health",
			"service/container/compute",
			"service/terminal",
			"settings/general",
			"settings/email",
		]) {
			expect(visibleIn("simple", id)).toBe(true);
		}
	});
});

describe("currentHref", () => {
	const hrefs = [
		"/services/a",
		"/services/a/environments",
		"/services/a/environments/revisions",
	];

	test("picks the longest href the page sits under", () => {
		expect(currentHref("/services/a/environments/revisions/r1", hrefs)).toBe(
			"/services/a/environments/revisions",
		);
		expect(currentHref("/services/a/environments", hrefs)).toBe(
			"/services/a/environments",
		);
		expect(currentHref("/services/a", hrefs)).toBe("/services/a");
	});

	test("doesn't match a sibling that only shares a prefix", () => {
		expect(currentHref("/services/ab", hrefs)).toBeUndefined();
		expect(currentHref("/settings", ["/settings/docker"])).toBeUndefined();
	});

	test("reads a relative href against the current page", () => {
		expect(
			currentHref("/settings/ip-bans", ["../settings", "../settings/ip-bans"]),
		).toBe("../settings/ip-bans");
		expect(
			currentHref("/settings", ["./settings", "./settings/networking"]),
		).toBe("./settings");
	});

	test("the root matches every page", () => {
		expect(currentHref("/stacks", ["/"])).toBe("/");
	});
});

describe("visibleItems", () => {
	const sections = [
		{ href: "/s/x/environments", id: "service/environments/environments" },
		{ href: "/s/x/environments/source", id: "service/environments/source" },
		{
			href: "/s/x/environments/revisions",
			id: "service/environments/revisions",
		},
	];

	test("advanced mode keeps every item in order", () => {
		expect(visibleItems("advanced", sections, "/s/x/environments")).toEqual(
			sections,
		);
	});

	test("simple mode drops the hidden ones", () => {
		expect(
			visibleItems("simple", sections, "/s/x/environments/source").map(
				(item) => item.id,
			),
		).toEqual(["service/environments/source"]);
	});

	test("keeps the hidden item the current page sits under", () => {
		expect(
			visibleItems("simple", sections, "/s/x/environments/revisions/r1").map(
				(item) => item.id,
			),
		).toEqual([
			"service/environments/source",
			"service/environments/revisions",
		]);
		expect(
			visibleItems("simple", sections, "/s/x/environments").map(
				(item) => item.id,
			),
		).toEqual([
			"service/environments/environments",
			"service/environments/source",
		]);
	});

	test("filters the sidebar by path", () => {
		const nav = ["/", "/services", "/registry", "/deployments"].map((href) => ({
			href,
			id: href,
		}));
		expect(visibleItems("simple", nav, "/services").map((n) => n.id)).toEqual([
			"/",
			"/services",
		]);
		expect(
			visibleItems("simple", nav, "/registry/library").map((n) => n.id),
		).toEqual(["/", "/services", "/registry"]);
	});
});

test("the front page's templates are real built-in templates", async () => {
	const root = join(import.meta.dir, "../../../templates");
	const files: Record<string, unknown> = {};
	for await (const name of new Bun.Glob("*/*.json").scan(root)) {
		files[`/templates/${name}`] = await Bun.file(join(root, name)).json();
	}
	const ids = new Set(
		parseBuiltinTemplates(files).templates.map((template) => template.id),
	);
	expect(SIMPLE_FRONT_PAGE_TEMPLATES.length).toBeGreaterThan(0);
	for (const id of SIMPLE_FRONT_PAGE_TEMPLATES) {
		expect(ids.has(id)).toBe(true);
	}
});
