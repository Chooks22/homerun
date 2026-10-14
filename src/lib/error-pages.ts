export const ERROR_PAGE_PATH = "/homerun-error";

export const HOMERUN_URL = "https://orochibraru.com/homerun";

export type ErrorPageKind = "blocked" | "notFound" | "notReady" | "unavailable";

export interface ErrorPageText {
	message: string;
	title: string;
}

/** The brand a gated app's sign-in pages show instead of Homerun's own. */
export interface AuthBranding {
	accentColor: string | null;
	brandName: string;
	logoUrl: string | null;
	poweredBy: boolean;
}

export interface ErrorPagesSettings {
	accentColor: string | null;
	brandName: string;
	logoUrl: string | null;
	pages: Record<ErrorPageKind, ErrorPageText>;
	showPoweredBy: boolean;
}

export const ERROR_PAGE_KINDS: { kind: ErrorPageKind; label: string }[] = [
	{ kind: "notReady", label: "Not available yet" },
	{ kind: "unavailable", label: "Temporarily unavailable" },
	{ kind: "notFound", label: "Nothing here" },
	{ kind: "blocked", label: "Blocked path" },
];

export const DEFAULT_ERROR_PAGES: ErrorPagesSettings = {
	accentColor: null,
	brandName: "Homerun",
	logoUrl: null,
	pages: {
		blocked: {
			message:
				"This address isn't available. If you think it should be, contact the site's owner.",
			title: "Access denied",
		},
		notFound: {
			message:
				"There's no app at this address. Check the link, or come back later.",
			title: "Nothing here",
		},
		notReady: {
			message:
				"This app isn't available yet: it's on its way. Come back in a few minutes, this page checks again on its own.",
			title: "Almost there",
		},
		unavailable: {
			message:
				"This app is restarting or having trouble right now. This page checks again on its own.",
			title: "Temporarily unavailable",
		},
	},
	showPoweredBy: true,
};

/** The host a request proxied by Traefik was sent to, from `X-Forwarded-Host` (else `Host`), without its port. */
export function forwardedHost(headers: Headers): string | null {
	return (
		(headers.get("x-forwarded-host") ?? headers.get("host"))
			?.split(",")[0]
			?.trim()
			.replace(/:\d+$/, "")
			.toLowerCase() || null
	);
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Whether `value` is a `#rrggbb` colour, the only accent format the error pages accept. */
export function isHexColor(value: string): boolean {
	return HEX_COLOR_RE.test(value);
}

/** Stored error page settings with every missing or blank field filled from the defaults. */
export function withErrorPageDefaults(
	stored: Partial<ErrorPagesSettings> | null | undefined,
): ErrorPagesSettings {
	const pages = Object.fromEntries(
		ERROR_PAGE_KINDS.map(({ kind }) => {
			const text = stored?.pages?.[kind];
			const fallback = DEFAULT_ERROR_PAGES.pages[kind];
			return [
				kind,
				{
					message: text?.message?.trim() || fallback.message,
					title: text?.title?.trim() || fallback.title,
				},
			];
		}),
	) as Record<ErrorPageKind, ErrorPageText>;
	return {
		accentColor:
			stored?.accentColor && isHexColor(stored.accentColor)
				? stored.accentColor
				: null,
		brandName: stored?.brandName?.trim() || DEFAULT_ERROR_PAGES.brandName,
		logoUrl: stored?.logoUrl?.trim() || null,
		pages,
		showPoweredBy: stored?.showPoweredBy ?? true,
	};
}

/**
 * Which page a status shows: a 404 is "not available yet" when the host
 * belongs to a service (its router isn't up, so it's still deploying or
 * stopped) and "nothing here" otherwise; any other status is "temporarily
 * unavailable".
 */
export function errorPageKind(
	status: number,
	hostBelongsToService: boolean,
): ErrorPageKind {
	if (status === 404) {
		return hostBelongsToService ? "notReady" : "notFound";
	}
	return "unavailable";
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const HOMERUN_MARK = `<svg class="mark" aria-hidden="true" viewBox="0 0 32 32"><mask id="m"><rect width="32" height="32" fill="#fff"/><path fill="none" stroke="#000" stroke-linecap="round" stroke-width="2.8" d="M9.5 21Q12 12 25 8.5"/></mask><path fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" d="M4 10.5a1.5 1.5 0 0 1 1.5-1.5h19a1.5 1.5 0 0 1 1.5 1.5V19l-11 9.5L4 19Z" mask="url(#m)"/><circle cx="27.5" cy="6" r="2.6" fill="currentColor"/></svg>`;

/**
 * The whole error page as one self-contained HTML document: inline styles,
 * inline logo unless a logo URL is set, no script and no request back to the
 * page's own host, since every path on an unrouted host lands on this page.
 * A "not available yet" or "temporarily unavailable" page reloads itself
 * every 15 seconds, so a visitor lands on the app once it's up.
 */
export function renderErrorPage(
	settings: ErrorPagesSettings,
	kind: ErrorPageKind,
	status: number,
): string {
	const text = settings.pages[kind];
	const brand = escapeHtml(settings.brandName);
	const accent = settings.accentColor ?? "oklch(0.43 0.145 8)";
	const logo = settings.logoUrl
		? `<img class="logo" src="${escapeHtml(settings.logoUrl)}" alt="${brand}">`
		: HOMERUN_MARK;
	const refresh =
		kind === "notReady" || kind === "unavailable"
			? `<meta http-equiv="refresh" content="15">`
			: "";
	const poweredBy = showsPoweredBy(settings)
		? `<p class="powered">Powered by <a href="${HOMERUN_URL}" rel="noopener" target="_blank">Homerun</a></p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${escapeHtml(text.title)} · ${brand}</title>
<style>
:root{--accent:${accent};--bg:#faf8f7;--card:#fff;--text:#1c1917;--muted:#78716c;--border:#e7e5e4;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141110;--card:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--border:#2e2a28}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:32px 28px;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;letter-spacing:-.01em}
.mark{width:22px;height:22px;color:var(--accent)}
.logo{max-height:40px;max-width:180px}
.status{margin:28px 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}
p{margin:0;color:var(--muted)}
.powered{margin-top:28px;font-size:12px}
.powered a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.powered a:hover{color:var(--accent)}
</style>
</head>
<body>
<main>
<div class="brand">${logo}${settings.logoUrl ? "" : `<span>${brand}</span>`}</div>
<p class="status">${status}</p>
<h1>${escapeHtml(text.title)}</h1>
<p>${escapeHtml(text.message)}</p>
${poweredBy}
</main>
</body>
</html>
`;
}

/** Each page's title and message from `<kind>Title` and `<kind>Message` fields (the settings form's, or the REST API's `pageTexts`), blank where left empty so the default shows. */
export function errorPageTextsFromForm(fields: {
	get(name: string): unknown;
}): Record<ErrorPageKind, ErrorPageText> {
	const field = (name: string, max: number) =>
		String(fields.get(name) ?? "")
			.trim()
			.slice(0, max);
	const pages = {} as Record<ErrorPageKind, ErrorPageText>;
	for (const { kind } of ERROR_PAGE_KINDS) {
		pages[kind] = {
			message: field(`${kind}Message`, 400),
			title: field(`${kind}Title`, 80),
		};
	}
	return pages;
}

/** Whether a page under another brand credits Homerun at its foot. */
export function showsPoweredBy(settings: ErrorPagesSettings): boolean {
	return (
		settings.showPoweredBy &&
		settings.brandName !== DEFAULT_ERROR_PAGES.brandName
	);
}

/**
 * The error pages' brand, for the sign-in pages of a gated app, or null when
 * nothing has been changed from Homerun's own.
 */
export function authBranding(
	settings: ErrorPagesSettings,
): AuthBranding | null {
	if (
		settings.brandName === DEFAULT_ERROR_PAGES.brandName &&
		!(settings.logoUrl || settings.accentColor)
	) {
		return null;
	}
	return {
		accentColor: settings.accentColor,
		brandName: settings.brandName,
		logoUrl: settings.logoUrl,
		poweredBy: showsPoweredBy(settings),
	};
}

/**
 * Inline CSS that repaints the theme's accent tokens in a brand's colour, or
 * an empty string to keep the theme's own. The colour is a validated
 * `#rrggbb`, so it's safe in a `style` attribute.
 */
export function brandAccentStyle(branding: AuthBranding | null): string {
	const color = branding?.accentColor;
	if (!(color && isHexColor(color))) {
		return "";
	}
	return [
		`--color-accent:${color}`,
		`--color-ink:${color}`,
		`--primary:${color}`,
		`--color-accent-light:color-mix(in oklch, ${color} 12%, transparent)`,
		`--color-accent-glow:color-mix(in oklch, ${color} 35%, transparent)`,
	].join(";");
}
