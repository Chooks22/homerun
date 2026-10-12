import { fail, redirect } from "@sveltejs/kit";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { Logger } from "#lib/logger.js";
import { manageableCronJob } from "#lib/server/cron-job-form.js";
import { enqueueCronJobRun } from "#lib/services/cron-job-queue.js";
import { resolve } from "$app/paths";

const logger = new Logger("CronJob");

export const load = async ({ parent }) => {
	const { job } = await parent();
	const runs = await CronJobRunDTO.listForJob(job.id);
	return { runs: runs.map((run) => run.toJSON()) };
};

export const actions = {
	runNow: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
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
