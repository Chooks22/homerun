import { error } from "@sveltejs/kit";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { can } from "#lib/permissions.js";

export const load = async ({ locals, params, parent }) => {
	await parent();
	const job = await CronJobDTO.get(params.cronJobId);
	if (!job) {
		error(404, "Cron job not found");
	}
	return {
		hostAccess: can(locals.permissions, "system", "write"),
		job: job.toJSON(),
	};
};
