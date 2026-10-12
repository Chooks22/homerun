import { error } from "@sveltejs/kit";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";

export const load = async ({ params, parent }) => {
	const { job } = await parent();
	const run = await CronJobRunDTO.getForJob(job.id, params.runId);
	if (!run) {
		error(404, "Run not found");
	}
	return { run: run.toJSON() };
};
