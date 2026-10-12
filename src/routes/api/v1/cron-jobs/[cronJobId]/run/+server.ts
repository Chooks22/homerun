import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { can } from "#lib/permissions.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import { enqueueCronJobRun } from "#lib/services/cron-job-queue.js";

export const POST = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const job = await CronJobDTO.get(params.cronJobId);
	if (!job) {
		return apiError("Not found", 404);
	}
	if (job.kind === "exec" && !can(caller.permissions, "system", "write")) {
		return apiError(
			"Running a host command job needs write access to System.",
			403,
		);
	}
	const entry = await enqueueCronJobRun(job);
	return Response.json(
		{ jobId: entry.id, status: entry.status },
		{ status: 202 },
	);
};
