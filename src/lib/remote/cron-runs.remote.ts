import { error } from "@sveltejs/kit";
import { z } from "zod";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import type { CronJobRun } from "#lib/server/db/schema.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import type { JobStatus } from "#lib/types.js";
import { query } from "$app/server";

export interface CronJobActivity {
	active: { id: string; status: JobStatus } | null;
	runs: CronJobRun[];
}

/**
 * A cron job's runs plus the queue job of a run that's queued or running, if
 * any. Re-read while a run is pending or going : the container's output is
 * appended to the row as it arrives (see `CronJobRunDTO.appendOutput`), so a
 * long job shows its progress instead of nothing until it exits.
 */
export const getCronJobRuns = query(
	z.string(),
	async (cronJobId): Promise<CronJobActivity> => {
		requirePermission("cron-jobs", "read");
		const job = await CronJobDTO.get(cronJobId);
		if (!job) {
			return { active: null, runs: [] };
		}
		const [runs, active] = await Promise.all([
			CronJobRunDTO.listForJob(job.id),
			JobDTO.findActive("cron_job", `cron_job:${job.id}`),
		]);
		const activeRow = active?.toJSON();
		return {
			active: activeRow ? { id: activeRow.id, status: activeRow.status } : null,
			runs: runs.map((run) => run.toJSON()),
		};
	},
);

/** One run of a cron job, re-read while it's still going so its page follows the output. */
export const getCronJobRun = query(
	z.object({ cronJobId: z.string(), runId: z.string() }),
	async ({ cronJobId, runId }): Promise<CronJobRun> => {
		requirePermission("cron-jobs", "read");
		const run = await CronJobRunDTO.getForJob(cronJobId, runId);
		if (!run) {
			error(404, "Run not found");
		}
		return run.toJSON();
	},
);
