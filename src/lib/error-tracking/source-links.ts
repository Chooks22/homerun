export type SourceProvider = "github" | "gitlab" | "gitea" | "bitbucket";

const SCHEME_PREFIXES = [
	"webpack-internal:///",
	"webpack:///",
	"webpack://",
	"file://",
	"app:///",
	"app://",
];

const BUILD_ROOTS = [
	"/usr/src/app/",
	"/workspace/repo/",
	"/home/node/app/",
	"/opt/app/",
	"/go/src/app/",
	"/workspace/",
	"/app/",
	"/build/",
	"/code/",
	"/src/",
];

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SCP_RE = /^[\w.-]+@([\w.-]+):(.+)$/;

/** Whether an event's release looks like a git commit, which is what Homerun injects for git builds. */
export function isCommitSha(release: string | null): release is string {
	return !!release && SHA_RE.test(release);
}

/**
 * The path of a stack frame's file relative to the repository root, or null
 * when it can't be one: a URL (a minified browser bundle), or an absolute path
 * outside every known build root. Strips `webpack://`/`file://`/`app:///`
 * prefixes, a webpack project name before `/./`, the usual image build roots
 * (`/app/`, `/usr/src/app/`, `/workspace/repo/` and friends) and `./`, then
 * prefixes the service's build context when it builds from a subdirectory.
 */
export function repoRelativePath(
	path: string | null,
	buildContext: string | null = null,
): string | null {
	if (!path) {
		return null;
	}
	let rest = path.replace(/[?#].*$/, "");
	for (const prefix of SCHEME_PREFIXES) {
		if (rest.startsWith(prefix)) {
			rest = rest.slice(prefix.length);
			const project = rest.indexOf("/./");
			if (project !== -1) {
				rest = rest.slice(project + 3);
			}
			if (prefix.startsWith("app") || prefix.startsWith("webpack")) {
				rest = rest.replace(/^\/+/, "");
			}
			break;
		}
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) {
		return null;
	}
	if (rest.startsWith("/")) {
		const root = BUILD_ROOTS.find((candidate) => rest.startsWith(candidate));
		if (!root) {
			return null;
		}
		rest = rest.slice(root.length);
	}
	rest = rest.replace(/^(\.\/)+/, "");
	if (!rest || rest.startsWith("../") || rest.includes("node_modules/")) {
		return null;
	}
	const context = (buildContext ?? "")
		.replace(/^(\.\/)+|^\/+|\/+$/g, "")
		.replace(/^\.$/, "");
	return context && !rest.startsWith(`${context}/`)
		? `${context}/${rest}`
		: rest;
}

/** The provider a git URL is hosted on, going by its well-known host. */
export function providerFromHost(host: string): SourceProvider | null {
	if (host === "github.com" || host.startsWith("github.")) {
		return "github";
	}
	if (host === "gitlab.com" || host.startsWith("gitlab.")) {
		return "gitlab";
	}
	if (host === "bitbucket.org") {
		return "bitbucket";
	}
	if (host.startsWith("gitea.") || host === "codeberg.org") {
		return "gitea";
	}
	return null;
}

/**
 * The browsable https URL of a repository from its clone URL: https or
 * scp-style SSH, credentials and `.git` stripped. Null when unparseable.
 */
export function repoWebUrl(gitUrl: string): string | null {
	const trimmed = gitUrl.trim();
	const scp = SCP_RE.exec(trimmed);
	let host: string;
	let pathname: string;
	if (scp) {
		host = scp[1];
		pathname = `/${scp[2]}`;
	} else {
		try {
			const url = new URL(trimmed);
			host = url.host;
			pathname = url.pathname;
		} catch {
			return null;
		}
	}
	const repo = pathname.replace(/\/+$/, "").replace(/\.git$/, "");
	return repo.length > 1 ? `https://${host.toLowerCase()}${repo}` : null;
}

/**
 * A link to one line of a file at one commit, or at the head of a branch
 * when `branch` is set, in the URL format of the provider hosting the
 * repository.
 */
export function sourceFileUrl(input: {
	branch?: boolean;
	commit: string;
	line: number | null;
	path: string;
	provider: SourceProvider;
	repoUrl: string;
}): string {
	const { commit, line, provider, repoUrl } = input;
	const path = input.path.split("/").map(encodeURIComponent).join("/");
	const base = repoUrl.replace(/\/+$/, "");
	switch (provider) {
		case "github":
			return `${base}/blob/${commit}/${path}${line ? `#L${line}` : ""}`;
		case "gitlab":
			return `${base}/-/blob/${commit}/${path}${line ? `#L${line}` : ""}`;
		case "gitea":
			return `${base}/src/${input.branch ? "branch" : "commit"}/${commit}/${path}${line ? `#L${line}` : ""}`;
		case "bitbucket":
			return `${base}/src/${commit}/${path}${line ? `#lines-${line}` : ""}`;
		default: {
			const exhaustive: never = provider;
			return exhaustive;
		}
	}
}
