export const DEFAULT_WORKSTATION_IMAGE = "codercom/code-server:latest";
export const DEFAULT_WORKSTATION_PORT = 8080;
export const DEFAULT_WORKSTATION_HOME = "/home/coder";

export const WORKSTATION_STATES = [
	"pulling",
	"starting",
	"cloning",
	"running",
	"stopped",
	"failed",
	"missing",
] as const;

export type WorkstationState = (typeof WORKSTATION_STATES)[number];

/** What the worker or agent reports about one workstation. */
export interface WorkstationStatus {
	containerId?: string;
	error?: string;
	hostPort: number;
	state: WorkstationState;
}

const BUSY_STATES: ReadonlySet<WorkstationState> = new Set([
	"pulling",
	"starting",
	"cloning",
]);

/** Whether a start is still under way, so a page keeps polling. */
export function isWorkstationBusy(state: WorkstationState): boolean {
	return BUSY_STATES.has(state);
}

/** The label a state reads as on the dashboard. */
export function workstationStateLabel(state: WorkstationState): string {
	switch (state) {
		case "pulling":
			return "Pulling image";
		case "starting":
			return "Starting";
		case "cloning":
			return "Cloning repository";
		case "running":
			return "Running";
		case "failed":
			return "Failed";
		case "missing":
			return "Not created";
		default:
			return "Stopped";
	}
}

/** The `<slug>.<baseDomain>` hostname a workstation is routed at. */
export function workstationHostname(slug: string, baseDomain: string): string {
	return `${slug}.${baseDomain}`;
}

/** The directory a repository is cloned into under the home path: its last path segment, without `.git`. */
export function repoDirectory(gitUrl: string): string {
	try {
		const last = new URL(gitUrl).pathname.replace(/\/+$/, "").split("/").pop();
		const name = (last ?? "").replace(/\.git$/, "");
		return /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.+$/.test(name)
			? name
			: "project";
	} catch {
		return "project";
	}
}

export const AUTO_STOP_MODES = ["idle", "timer"] as const;

export type AutoStopMode = (typeof AUTO_STOP_MODES)[number];

export type AutoStopStep =
	| { at: Date; kind: "arm" }
	| { kind: "stop" }
	| { kind: "wait" };

/**
 * What the auto-stop pass does with one running workstation: push its
 * deadline `minutes` out (idle mode while a browser is connected, or no
 * deadline yet), stop it once the deadline passed, or wait.
 */
export function autoStopStep(input: {
	active: boolean;
	autoStopAt: Date | null;
	minutes: number;
	mode: AutoStopMode;
	now: Date;
}): AutoStopStep {
	const at = new Date(input.now.getTime() + input.minutes * 60_000);
	if ((input.mode === "idle" && input.active) || !input.autoStopAt) {
		return { at, kind: "arm" };
	}
	return input.autoStopAt <= input.now ? { kind: "stop" } : { kind: "wait" };
}

/** How an auto-stop setting reads on the dashboard. */
export function autoStopLabel(
	mode: AutoStopMode | null,
	minutes: number | null,
): string {
	if (!mode || !minutes) {
		return "Off";
	}
	return mode === "idle"
		? `After ${minutes} min with no browser connected`
		: `${minutes} min after it starts`;
}
