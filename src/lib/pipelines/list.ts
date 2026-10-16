import { type SortOption, sortKeysOf } from "#lib/list-sorts.js";
import { formatSpanDuration } from "#lib/tracing/waterfall.js";
import type { PipelineProvider, PipelineStatus } from "./types.ts";

export const PIPELINE_SORTS: SortOption[] = [
	{ label: "Newest", value: "-created" },
	{ label: "Slowest", value: "-duration" },
	{ label: "Most expensive", value: "-cost" },
	{ label: "Workflow", value: "name" },
];

export const PIPELINE_SORT_KEYS = sortKeysOf(PIPELINE_SORTS);

export const PIPELINE_FILTER_KEYS = ["status"];

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
	cancelled: "Cancelled",
	failure: "Failed",
	queued: "Queued",
	running: "Running",
	skipped: "Skipped",
	success: "Passed",
};

export const PIPELINE_PROVIDER_LABELS: Record<PipelineProvider, string> = {
	gitea: "Gitea Actions",
	github: "GitHub Actions",
	gitlab: "GitLab CI",
};

/** A dollar amount, to the cent past a dollar and to a tenth of a cent below. */
export function formatUsd(value: number): string {
	if (value <= 0) {
		return "$0";
	}
	return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

/** A run or job duration, or a dash when it hasn't finished. */
export function formatRunDuration(ms: number | null): string {
	return ms === null ? "—" : formatSpanDuration(ms);
}
