import { fail } from "@sveltejs/kit";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import { Logger } from "#lib/logger.js";
import { manageableCronJob } from "#lib/server/cron-job-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { enqueueCronJobRun } from "#lib/services/cron-job-queue.js";

const logger = new Logger("CronJob");

export const load = async ({ parent }) => {
	const { job } = await parent();
	const [runs, active] = await Promise.all([
		CronJobRunDTO.listForJob(job.id),
		JobDTO.findActive("cron_job", `cron_job:${job.id}`),
	]);
	const activeRow = active?.toJSON();
	return {
		active: activeRow ? { id: activeRow.id, status: activeRow.status } : null,
		runs: runs.map((run) => run.toJSON()),
	};
};

export const actions = {
	runNow: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const found = await manageableCronJob(params.cronJobId, locals.permissions);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		const entry = await enqueueCronJobRun(found.job);
		logger.info(`Cron job run queued: job=${found.job.id} queued=${entry.id}`);
		return { queued: true };
	},
};
