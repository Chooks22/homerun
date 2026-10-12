import { and, desc, eq } from "drizzle-orm";
import type { CronJobRunTrigger } from "#lib/cron-job-script.js";
import { db } from "#lib/server/db/lib.js";
import { type CronJobRun, cronJob, cronJobRun } from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

const MAX_OUTPUT_CHARS = 64_000;

export interface CronJobRunResult {
	error?: string | null;
	exitCode?: number | null;
	output?: string;
	success: boolean;
}

/**
 * Wraps the `cron_job_run` table : one execution of a cron job, with its
 * captured output and outcome.
 */
export class CronJobRunDTO extends BaseDTO<CronJobRun> {
	/**
	 * Inserts a new in-progress run for a cron job, stamped as started now with
	 * empty output, remembering the queue job executing it (whose id the
	 * worker's trace spans carry) and what triggered it.
	 */
	static async create(
		cronJobId: string,
		origin: { jobId: string; trigger: CronJobRunTrigger },
	): Promise<CronJobRunDTO> {
		const row: CronJobRun = {
			cronJobId,
			error: null,
			exitCode: null,
			finishedAt: null,
			id: crypto.randomUUID(),
			jobId: origin.jobId,
			output: "",
			startedAt: new Date(),
			success: null,
			trigger: origin.trigger,
		};
		await db.insert(cronJobRun).values(row);
		return new CronJobRunDTO(row);
	}

	/** Loads one run by id; null when missing. */
	static async get(id: string): Promise<CronJobRunDTO | null> {
		const [row] = await db
			.select()
			.from(cronJobRun)
			.where(eq(cronJobRun.id, id))
			.limit(1);
		return row ? new CronJobRunDTO(row) : null;
	}

	/** Loads one run of one cron job; null when missing or when it belongs to another job. */
	static async getForJob(
		cronJobId: string,
		id: string,
	): Promise<CronJobRunDTO | null> {
		const [row] = await db
			.select()
			.from(cronJobRun)
			.where(and(eq(cronJobRun.id, id), eq(cronJobRun.cronJobId, cronJobId)))
			.limit(1);
		return row ? new CronJobRunDTO(row) : null;
	}

	/** Appends to a still-running run's output, so the page polling it shows a long job's progress instead of nothing until it exits. */
	async appendOutput(chunk: string): Promise<void> {
		if (!chunk) {
			return;
		}
		const next = `${this.row.output ?? ""}${chunk}`;
		const output =
			next.length > MAX_OUTPUT_CHARS
				? next.slice(next.length - MAX_OUTPUT_CHARS)
				: next;
		await db
			.update(cronJobRun)
			.set({ output })
			.where(eq(cronJobRun.id, this.row.id));
		this.row.output = output;
	}

	/** The run's captured output so far, trimmed to the newest 64k characters. */
	get output(): string {
		return this.row.output ?? "";
	}

	/**
	 * Records a run's outcome, exit code and final output (trimmed to its newest
	 * 64k characters) and stamps it finished.
	 */
	async finish(result: CronJobRunResult): Promise<void> {
		const output = result.output ?? "";
		const patch = {
			error: result.error ?? null,
			exitCode: result.exitCode ?? null,
			finishedAt: new Date(),
			output:
				output.length > MAX_OUTPUT_CHARS
					? output.slice(output.length - MAX_OUTPUT_CHARS)
					: output,
			success: result.success,
		};
		await db
			.update(cronJobRun)
			.set(patch)
			.where(eq(cronJobRun.id, this.row.id));
		Object.assign(this.row, patch);
	}

	/** Most recent runs of one cron job, newest first. */
	static async listForJob(
		cronJobId: string,
		limit = 20,
	): Promise<CronJobRunDTO[]> {
		const rows = await db
			.select()
			.from(cronJobRun)
			.where(eq(cronJobRun.cronJobId, cronJobId))
			.orderBy(desc(cronJobRun.startedAt))
			.limit(limit);
		return rows.map((row) => new CronJobRunDTO(row));
	}

	/**
	 * Most recent runs across every cron job on the instance, newest first, each
	 * paired with its job's name.
	 */
	static async listRecent(
		limit = 20,
	): Promise<Array<{ jobName: string; run: CronJobRunDTO }>> {
		const rows = await db
			.select({ jobName: cronJob.name, row: cronJobRun })
			.from(cronJobRun)
			.innerJoin(cronJob, eq(cronJobRun.cronJobId, cronJob.id))
			.orderBy(desc(cronJobRun.startedAt))
			.limit(limit);
		return rows.map((r) => ({
			jobName: r.jobName,
			run: new CronJobRunDTO(r.row),
		}));
	}

	/** The run's id. */
	get id(): string {
		return this.row.id;
	}
}
