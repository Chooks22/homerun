import { billableMinutes, rateFor } from "./cost.ts";
import {
	type FetchedJob,
	type FetchedRun,
	isFinished,
	type PipelineJob,
	type PipelineRateRule,
	type PipelineStatus,
} from "./types.ts";

export interface RunSummary {
	actor: string | null;
	attempt: number;
	billableMinutes: number;
	branch: string | null;
	commitSha: string | null;
	costUsd: number;
	createdAt: Date;
	durationMs: number | null;
	event: string | null;
	finishedAt: Date | null;
	jobs: PipelineJob[];
	name: string;
	number: number | null;
	queueMs: number | null;
	startedAt: Date | null;
	status: PipelineStatus;
	title: string | null;
	url: string | null;
}

function earliest(times: (string | null)[]): string | null {
	const values = times.filter((time): time is string => time !== null);
	return values.length ? values.reduce((a, b) => (a < b ? a : b)) : null;
}

function latest(times: (string | null)[]): string | null {
	const values = times.filter((time): time is string => time !== null);
	return values.length ? values.reduce((a, b) => (a > b ? a : b)) : null;
}

function dateOf(time: string | null): Date | null {
	return time ? new Date(time) : null;
}

function between(from: Date | null, to: Date | null): number | null {
	if (!(from && to)) {
		return null;
	}
	return Math.max(0, to.getTime() - from.getTime());
}

/**
 * A fetched run and its jobs as the row Homerun stores: queued, started and
 * finished times (falling back on the jobs' when the run lacks them), the
 * time spent queued before the first job started, the wall-clock duration,
 * and each job's billable minutes and cost at the service's rates. Every
 * attempt's jobs are costed, but times come from the latest attempt alone,
 * and a re-run counts as queued from when it started, not from when the
 * first attempt was created.
 */
export function summarizeRun(
	run: FetchedRun,
	fetched: { jobs: FetchedJob[]; title: string | null },
	rules: PipelineRateRule[],
	now: Date,
): RunSummary {
	const jobs: PipelineJob[] = fetched.jobs.map((job) => {
		const minutes = billableMinutes(job.startedAt, job.finishedAt);
		const cost = minutes * rateFor(rules, job.labels, job.runner);
		return {
			attempt: job.attempt ?? run.attempt,
			billableMinutes: minutes,
			costUsd: Math.round(cost * 10_000) / 10_000,
			durationMs: between(dateOf(job.startedAt), dateOf(job.finishedAt)),
			finishedAt: job.finishedAt,
			labels: job.labels,
			name: job.name,
			runner: job.runner,
			stage: job.stage,
			startedAt: job.startedAt,
			status: job.status,
			steps: job.steps,
			url: job.url,
		};
	});
	const current = fetched.jobs.filter(
		(job) => (job.attempt ?? run.attempt) === run.attempt,
	);
	const firstJobStart = dateOf(earliest(current.map((j) => j.startedAt)));
	const rerunStart = run.attempt > 1 ? dateOf(run.startedAt) : null;
	const createdAt =
		rerunStart ??
		dateOf(run.createdAt) ??
		dateOf(earliest(current.map((j) => j.createdAt))) ??
		dateOf(run.startedAt) ??
		firstJobStart ??
		now;
	const startedAt = dateOf(run.startedAt) ?? firstJobStart;
	const finishedAt = isFinished(run.status)
		? (dateOf(latest(current.map((j) => j.finishedAt))) ??
			dateOf(run.finishedAt))
		: null;
	const minutes = jobs.reduce((sum, job) => sum + job.billableMinutes, 0);
	const cost = jobs.reduce((sum, job) => sum + job.costUsd, 0);
	return {
		actor: run.actor,
		attempt: run.attempt,
		billableMinutes: minutes,
		branch: run.branch,
		commitSha: run.commitSha,
		costUsd: Math.round(cost * 10_000) / 10_000,
		createdAt,
		durationMs: between(startedAt ?? createdAt, finishedAt),
		event: run.event,
		finishedAt,
		jobs,
		name: run.name,
		number: run.number,
		queueMs: between(createdAt, firstJobStart ?? startedAt),
		startedAt,
		status: run.status,
		title: run.title ?? fetched.title,
		url: run.url,
	};
}

/** A stored run's jobs re-costed at new rates, with the run's new total. */
export function recostJobs(
	jobs: PipelineJob[],
	rules: PipelineRateRule[],
): { costUsd: number; jobs: PipelineJob[] } {
	const next = jobs.map((job) => ({
		...job,
		costUsd:
			Math.round(
				job.billableMinutes * rateFor(rules, job.labels, job.runner) * 10_000,
			) / 10_000,
	}));
	const total = next.reduce((sum, job) => sum + job.costUsd, 0);
	return { costUsd: Math.round(total * 10_000) / 10_000, jobs: next };
}
