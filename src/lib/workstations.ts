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
