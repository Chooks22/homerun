import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { can } from "#lib/permissions.js";
import { cronJobApiJson } from "#lib/server/api-json.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { parseCronJobInput } from "#lib/server/cron-job-form.js";
import { cronJobApiBody } from "#lib/server/validation/api-resources.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const paged = await CronJobDTO.listPaged(parseApiListQuery(url));
	return jsonPage(
		paged.items.map((job) => cronJobApiJson(job.toJSON())),
		paged,
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, cronJobApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { envVars, files, ...fields } = body.data;
	const result = parseCronJobInput(
		Object.fromEntries(
			Object.entries(fields).filter(([, value]) => value !== null),
		),
		envVars,
		files,
		{ hostAccess: can(caller.permissions, "system", "write") },
	);
	if ("error" in result) {
		return apiError(result.error);
	}
	const job = await CronJobDTO.create({
		...result.parsed,
		userId: caller.userId,
	});
	return Response.json(cronJobApiJson(job.toJSON()), { status: 201 });
};
