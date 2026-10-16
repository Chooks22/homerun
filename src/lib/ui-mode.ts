export type UiMode = "advanced" | "simple";

export const DEFAULT_UI_MODE: UiMode = "advanced";

export const UI_MODES = [
	"simple",
	"advanced",
] as const satisfies readonly UiMode[];

export const UI_MODE_LABELS: Record<UiMode, string> = {
	advanced: "Advanced",
	simple: "Simple",
};

export const UI_MODE_DESCRIPTIONS: Record<UiMode, string> = {
	advanced:
		"Every feature in view: environments, release channels, previews, revisions, infrastructure as code, object storage, build servers, the registry and observability in depth.",
	simple:
		"Self-hosting through click-ops: a short sidebar, templates and one-click deploys up front, sensible defaults, and the engineering settings out of the way.",
};

export const SIMPLE_FRONT_PAGE_TEMPLATES: readonly string[] = [
	"builtin-jellyfin",
	"builtin-immich",
	"builtin-vaultwarden",
	"builtin-home-assistant",
	"builtin-nextcloud",
	"builtin-paperless-ngx",
	"builtin-adguard-home",
	"builtin-uptime-kuma",
];

const ADVANCED_ONLY: ReadonlySet<string> = new Set([
	"/deployments",
	"/remote-hosts",
	"/scheduling",
	"/terminal",
	"/build-cache-registries",
	"/object-storage",
	"/iac",
	"/idp",
	"/api-docs",
	"/system-logs",
	"/registry",
	"/docker-cleanup",
	"monitoring/traces",
	"monitoring/crowdsec",
	"monitoring/settings",
	"service/environments/environments",
	"service/environments/revisions",
	"service/environments/previews",
	"service/environments/channels",
	"service/environments/source#build",
	"service/observability/errors",
	"service/observability/traces",
	"service/observability/pipelines",
	"service/observability/health#settings",
	"service/container/runtime",
	"service/container#replicas",
	"service/networking#network-mode",
	"service/networking#http-cache",
	"service/networking#published-ports",
	"service/security#blocked-paths",
	"service/security#login-wall-paths",
	"services/new#build",
	"services/new#network",
	"services/new#compute",
	"settings/docker",
	"settings/tls",
	"settings/error-pages",
	"settings/ip-bans",
]);

/** Narrows a stored or submitted value to a UI mode. */
export function isUiMode(value: unknown): value is UiMode {
	return value === "simple" || value === "advanced";
}

/**
 * The mode the dashboard renders in: the account's own choice, else the
 * instance default, else advanced (so an instance that never picked one
 * keeps everything in view).
 */
export function effectiveUiMode(
	userPreference: UiMode | null | undefined,
	instanceDefault: UiMode | null | undefined,
): UiMode {
	return userPreference ?? instanceDefault ?? DEFAULT_UI_MODE;
}

/**
 * Whether the sidebar entry, tab, section or page block with this id shows in
 * `mode`. Sidebar entries are keyed by their path (`/registry`), tabs and
 * sections by their route under the page (`service/observability/errors`),
 * blocks inside a page by `<page>#<block>`.
 */
export function visibleIn(mode: UiMode, id: string): boolean {
	return mode === "advanced" || !ADVANCED_ONLY.has(id);
}

/**
 * Whether `pathname` is `href` itself or a page under it. A relative href (what
 * `resolve()` returns while rendering on the server) is read against
 * `pathname` first, the way the browser would follow it.
 */
function isUnder(pathname: string, href: string): boolean {
	const target = new URL(href, `http://host${pathname}`).pathname;
	return (
		pathname === target || pathname.startsWith(`${target.replace(/\/$/, "")}/`)
	);
}

/**
 * The href among `hrefs` the current page sits under: the longest one that is
 * `pathname` or a prefix of it, so a bare tab never claims its siblings' pages.
 */
export function currentHref(
	pathname: string,
	hrefs: readonly string[],
): string | undefined {
	return hrefs
		.filter((href) => isUnder(pathname, href))
		.sort((a, b) => b.length - a.length)[0];
}

/**
 * Keeps the nav entries, tabs or sections `mode` shows, plus the one the
 * current page sits under, so landing on a hidden page directly still shows
 * where you are. Order is preserved.
 */
export function visibleItems<T extends { href: string; id: string }>(
	mode: UiMode,
	items: readonly T[],
	pathname: string,
): T[] {
	const current = currentHref(
		pathname,
		items.map((item) => item.href),
	);
	return items.filter(
		(item) => item.href === current || visibleIn(mode, item.id),
	);
}
