import { fail } from "@sveltejs/kit";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { manageableCronJob } from "#lib/server/cron-job-form.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { enqueueCronJobRun } from "#lib/services/cron-job-queue.js";

const logger = new Logger("CronJob");

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{
			filterKeys: ["kind", "enabled"],
			sortKeys: sortKeysOf(BASE_SORTS),
		},
		preferences.perPage,
	);
	const [paged, runs] = await Promise.all([
		CronJobDTO.listPaged(query),
		CronJobRunDTO.listRecent(),
	]);
	return {
		filtered: query.active,
		jobs: paged.items.map((j) => j.toJSON()),
		page: paged.page,
		perPage: paged.perPage,
		runs: runs.map((r) => ({ jobName: r.jobName, run: r.run.toJSON() })),
		total: paged.total,
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const found = await manageableCronJob(
			formData.get("jobId") as string | null,
			locals.permissions,
		);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		const { job } = found;

		await job.delete();
		logger.info(`Cron job deleted: job=${job.id} user=${locals.user.id}`);
		return { success: true };
	},

	runNow: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const found = await manageableCronJob(
			formData.get("jobId") as string | null,
			locals.permissions,
		);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		const { job } = found;

		const entry = await enqueueCronJobRun(job);
		logger.info(`Cron job run queued: job=${job.id} queued=${entry.id}`);
		return { queued: true };
	},
};
