import { CronJobRunDTO } from "#lib/dto/cron-job-run-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const run = await CronJobRunDTO.getForJob(params.cronJobId, params.runId);
	const row = run?.toJSON();
	return row
		? Response.json({ ...row, output: row.output ?? "" })
		: apiError("Not found", 404);
};
