export type PipelineProvider = "github" | "gitlab" | "gitea";

export type PipelineStatus =
	| "queued"
	| "running"
	| "success"
	| "failure"
	| "cancelled"
	| "skipped";

export const PIPELINE_STATUSES: PipelineStatus[] = [
	"queued",
	"running",
	"success",
	"failure",
	"cancelled",
	"skipped",
];

export interface PipelineRateRule {
	label: string;
	rate: number;
}

export interface PipelineStep {
	finishedAt: string | null;
	name: string;
	startedAt: string | null;
	status: PipelineStatus;
}

export interface PipelineJob {
	attempt: number;
	billableMinutes: number;
	costUsd: number;
	durationMs: number | null;
	finishedAt: string | null;
	labels: string[];
	name: string;
	runner: string | null;
	stage: string | null;
	startedAt: string | null;
	status: PipelineStatus;
	steps: PipelineStep[];
	url: string | null;
}

export interface FetchedJob {
	attempt: number | null;
	createdAt: string | null;
	finishedAt: string | null;
	labels: string[];
	name: string;
	runner: string | null;
	stage: string | null;
	startedAt: string | null;
	status: PipelineStatus;
	steps: PipelineStep[];
	url: string | null;
}

export interface FetchedRun {
	actor: string | null;
	attempt: number;
	branch: string | null;
	commitSha: string | null;
	createdAt: string | null;
	event: string | null;
	externalId: string;
	finishedAt: string | null;
	name: string;
	number: number | null;
	startedAt: string | null;
	status: PipelineStatus;
	title: string | null;
	url: string | null;
}

const FINISHED: ReadonlySet<PipelineStatus> = new Set([
	"success",
	"failure",
	"cancelled",
	"skipped",
]);

const ALIASES: Record<string, PipelineStatus> = {
	action_required: "queued",
	blocked: "queued",
	cancelled: "cancelled",
	canceled: "cancelled",
	canceling: "cancelled",
	completed: "success",
	created: "queued",
	error: "failure",
	failed: "failure",
	failure: "failure",
	in_progress: "running",
	manual: "queued",
	neutral: "skipped",
	pending: "queued",
	preparing: "queued",
	queued: "queued",
	requested: "queued",
	running: "running",
	scheduled: "queued",
	skipped: "skipped",
	stale: "skipped",
	startup_failure: "failure",
	success: "success",
	timed_out: "failure",
	waiting: "queued",
	waiting_for_resource: "queued",
};

/** Whether a run or job in this status won't change any more. */
export function isFinished(status: PipelineStatus): boolean {
	return FINISHED.has(status);
}

/**
 * One provider status as Homerun's: a GitHub or Gitea `status` plus
 * `conclusion` (the conclusion wins once the run is completed), or a GitLab
 * `status` alone. Anything unknown reads as queued while unfinished.
 */
export function normalizeStatus(
	status: unknown,
	conclusion: unknown = null,
): PipelineStatus {
	const state = typeof status === "string" ? status.toLowerCase() : "";
	const outcome =
		typeof conclusion === "string" && conclusion
			? (ALIASES[conclusion.toLowerCase()] ?? null)
			: null;
	if (outcome && (state === "completed" || isFinished(outcome))) {
		return outcome;
	}
	return ALIASES[state] ?? "queued";
}
