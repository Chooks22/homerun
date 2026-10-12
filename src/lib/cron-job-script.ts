export const CRON_JOB_KINDS = ["image", "script", "exec"] as const;

export type CronJobKind = (typeof CRON_JOB_KINDS)[number];

export const SCRIPT_RUNTIMES = [
	"bun",
	"node",
	"deno",
	"python",
	"shell",
] as const;

export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

export interface ScriptRuntimeSpec {
	file: string;
	image: string;
	label: string;
	run: (path: string) => string[];
}

export const SCRIPT_DIR = "/homerun";

export const SCRIPT_RUNTIME_SPECS: Record<ScriptRuntime, ScriptRuntimeSpec> = {
	bun: {
		file: "main.ts",
		image: "oven/bun:1-alpine",
		label: "Bun (TypeScript)",
		run: (path) => ["bun", "run", path],
	},
	deno: {
		file: "main.ts",
		image: "denoland/deno:alpine",
		label: "Deno (TypeScript)",
		run: (path) => ["deno", "run", "--allow-all", path],
	},
	node: {
		file: "main.mjs",
		image: "node:24-alpine",
		label: "Node.js",
		run: (path) => ["node", path],
	},
	python: {
		file: "main.py",
		image: "python:3.13-alpine",
		label: "Python",
		run: (path) => ["python", "-u", path],
	},
	shell: {
		file: "main.sh",
		image: "alpine:3",
		label: "Shell (sh)",
		run: (path) => ["sh", path],
	},
};

export interface CronJobFile {
	content: string;
	mode?: string;
	path: string;
}

export interface CronJobMount {
	containerPath: string;
	readOnly: boolean;
	volumeId: string;
}

const FILE_MODE_RE = /^[0-7]{3,4}$/;

export const MAX_CRON_JOB_FILES = 20;

export const MAX_CRON_JOB_FILE_BYTES = 64_000;

/** Narrows a submitted value to a script runtime, null when it isn't one. */
export function parseScriptRuntime(value: unknown): ScriptRuntime | null {
	return SCRIPT_RUNTIMES.find((runtime) => runtime === value) ?? null;
}

/** Where a script runtime's source file lands inside the container. */
export function scriptPath(runtime: ScriptRuntime): string {
	return `${SCRIPT_DIR}/${SCRIPT_RUNTIME_SPECS[runtime].file}`;
}

/**
 * Why `path` can't be a config file's destination, or null when it can : it
 * must be absolute, name a file rather than a directory, and have no `.` or
 * `..` segment.
 */
export function invalidFilePath(path: string): string | null {
	if (!path.startsWith("/")) {
		return `"${path}" isn't an absolute path.`;
	}
	if (path.endsWith("/")) {
		return `"${path}" is a directory, not a file.`;
	}
	const segments = path.slice(1).split("/");
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		return `"${path}" has an empty, "." or ".." segment.`;
	}
	return null;
}

/** Why `mode` can't be a config file's permissions, or null when it can : three or four octal digits. */
export function invalidFileMode(mode: string): string | null {
	return FILE_MODE_RE.test(mode)
		? null
		: `"${mode}" isn't an octal file mode like 600 or 0644.`;
}

/** Whether managing `job` needs write access to System : a host command, or a container given the Docker socket. */
export function cronJobNeedsHostAccess(job: {
	dockerSocket: boolean;
	kind: CronJobKind;
}): boolean {
	return job.kind === "exec" || job.dockerSocket;
}

/** What a job runs, for a list row or a page subtitle. */
export function describeCronJobTarget(job: {
	command: string | null;
	image: string | null;
	kind: CronJobKind;
	runtime: ScriptRuntime | null;
	tag: string | null;
}): string {
	if (job.kind === "exec") {
		return job.command ?? "host command";
	}
	if (job.kind === "script") {
		return job.runtime
			? `${SCRIPT_RUNTIME_SPECS[job.runtime].label} script`
			: "script";
	}
	return `${job.image}:${job.tag ?? "latest"}`;
}
