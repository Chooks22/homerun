export const AUTH_PATHS_MODES = ["all", "only", "except"] as const;

export type AuthPathsMode = (typeof AUTH_PATHS_MODES)[number];

export const MAX_PATH_PATTERNS = 100;

const MAX_PATTERN_LENGTH = 200;

export interface PathPatternPreset {
	description: string;
	id: string;
	label: string;
	patterns: string[];
}

export const PATH_PATTERN_PRESETS: PathPatternPreset[] = [
	{
		description: "What bots probe for on every site, WordPress or not.",
		id: "wordpress",
		label: "WordPress probes",
		patterns: [
			"wp-admin",
			"wp-login.php",
			"wp-config.php*",
			"wp-content",
			"wp-includes",
			"wp-json",
			"xmlrpc.php",
		],
	},
	{
		description:
			"Secrets and repository data an app should never serve: env files, git metadata, credentials, dumps.",
		id: "sensitive",
		label: "Sensitive files",
		patterns: [
			".env",
			".env.*",
			".git",
			".git-credentials",
			".gitconfig",
			".svn",
			".hg",
			".aws",
			".ssh",
			".htpasswd",
			".htaccess",
			".npmrc",
			".DS_Store",
			"*.sql",
			"*.sql.gz",
			"*.bak",
			"*.swp",
			"id_rsa*",
		],
	},
	{
		description: "Admin panels and tools scanners look for.",
		id: "admin",
		label: "Admin tools",
		patterns: [
			"phpmyadmin",
			"phpinfo.php",
			"adminer.php",
			"server-status",
			"cgi-bin",
		],
	},
];

/** The patterns an operator typed, one per line, trimmed and without duplicates. */
export function parsePathPatterns(text: string): string[] {
	return [
		...new Set(
			text
				.split("\n")
				.map((pattern) => pattern.trim())
				.filter(Boolean),
		),
	];
}

/** Why a path pattern can't be used, null when it can. */
export function pathPatternProblem(pattern: string): string | null {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		return `"${pattern.slice(0, 40)}…" is longer than ${MAX_PATTERN_LENGTH} characters.`;
	}
	if (/[\s`"\\]/.test(pattern) || /\p{Cc}/u.test(pattern)) {
		return `"${pattern}" contains whitespace, a quote or a backslash, which a path pattern can't.`;
	}
	if (!/[^*?/]/.test(pattern)) {
		return `"${pattern}" matches every path; turn the whole thing off instead.`;
	}
	return null;
}

/** The first problem in a list of patterns (too many, or one invalid), null when they're all usable. */
export function pathPatternsProblem(patterns: string[]): string | null {
	if (patterns.length > MAX_PATH_PATTERNS) {
		return `At most ${MAX_PATH_PATTERNS} patterns.`;
	}
	return patterns.map(pathPatternProblem).find(Boolean) ?? null;
}

/**
 * The regular expression one pattern stands for, in the syntax Go and
 * JavaScript share: `*` matches any run of characters, `/` included, `?`
 * exactly one. A pattern matches whole path segments anywhere in the path
 * (`.git` matches `/.git` and `/repo/.git/config`, not `/.github`), and a
 * leading `/` anchors it at the root (`/admin` matches `/admin/users` but
 * not `/blog/admin`).
 */
export function pathPatternRegex(pattern: string): string {
	const anchored = pattern.startsWith("/");
	const body = (anchored ? pattern.slice(1) : pattern)
		.split("")
		.map((char) => {
			if (char === "*") {
				return ".*";
			}
			if (char === "?") {
				return ".";
			}
			return char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
		})
		.join("");
	return `${anchored ? "^/" : "(?:^|/)"}${body}(?:/|$)`;
}

/** The first of `patterns` that `path` (query string and all) falls under, null when none does. */
export function matchingPathPattern(
	patterns: string[],
	path: string | null,
): string | null {
	const pathname = path?.split("?")[0];
	if (!pathname) {
		return null;
	}
	return (
		patterns.find((pattern) =>
			new RegExp(pathPatternRegex(pattern), "i").test(pathname),
		) ?? null
	);
}

/** One case-insensitive Go regular expression matching any of `patterns`, for a Traefik `PathRegexp` rule. */
export function pathPatternsRegex(patterns: string[]): string {
	return `(?i)${patterns.map(pathPatternRegex).join("|")}`;
}

/** Why a login wall can't cover `authPaths` under `authPathsMode`, null when it can: a mode other than `all` needs at least one pattern. */
export function authPathsProblem(
	authPathsMode: AuthPathsMode,
	authPaths: string[],
): string | null {
	return authPathsMode !== "all" && authPaths.length === 0
		? "Add at least one path pattern, or cover every path."
		: null;
}

export interface PathFilters {
	authPaths: string[];
	authPathsMode: AuthPathsMode;
	authRequired: boolean;
	blockedPaths: string[];
}

/** Whether going from `before` to `after` changes a service's routers: its blocked paths, or which paths its login wall covers while the wall is on. Turning the wall itself on or off isn't counted. */
export function pathFiltersChanged(
	before: PathFilters,
	after: PathFilters,
): boolean {
	const wall = (filters: PathFilters) =>
		filters.authPathsMode !== "all" && filters.authPaths.length > 0
			? `${filters.authPathsMode}\n${filters.authPaths.join("\n")}`
			: "all";
	return (
		before.blockedPaths.join("\n") !== after.blockedPaths.join("\n") ||
		(after.authRequired && wall(before) !== wall(after))
	);
}
