import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";

export const GET = async ({ locals, params, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const limit = Number(url.searchParams.get("limit") ?? 20);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		return apiError("limit must be a whole number from 1 to 100.");
	}
	const job = await CronJobDTO.get(params.cronJobId);
	if (!job) {
		return apiError("Not found", 404);
	}
	const runs = await CronJobRunDTO.listForJob(job.id, limit);
	return Response.json(
		runs.map((run) => {
			const { output, ...rest } = run.toJSON();
			return { ...rest, outputLength: output?.length ?? 0 };
		}),
	);
};
