import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { can } from "#lib/permissions.js";
import { cronJobApiJson } from "#lib/server/api-json.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { parseCronJobInput } from "#lib/server/cron-job-form.js";
import { updateCronJobApiBody } from "#lib/server/validation/api-resources.js";

/** The cron job, or the response refusing the caller: missing, or a host command job without host access. */
async function ownJob(id: string, hostAccess: boolean) {
	const job = await CronJobDTO.get(id);
	if (!job) {
		return apiError("Not found", 404);
	}
	return job.kind === "exec" && !hostAccess
		? apiError("Managing a host command job needs write access to System.", 403)
		: job;
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const job = await CronJobDTO.get(params.cronJobId);
	return job
		? Response.json(cronJobApiJson(job.toJSON()))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const hostAccess = can(caller.permissions, "system", "write");
	const job = await ownJob(params.cronJobId, hostAccess);
	if (job instanceof Response) {
		return job;
	}
	const body = await readApiBody(request, updateCronJobApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { envVars, files, ...fields } = body.data;
	const {
		envVars: currentEnv,
		files: currentFiles,
		registryPasswordEnc: _password,
		...current
	} = job.toJSON();
	const result = parseCronJobInput(
		Object.fromEntries(
			Object.entries({ ...current, ...fields }).filter(
				([, value]) => value !== null,
			),
		),
		envVars ?? currentEnv ?? {},
		files ?? currentFiles,
		{ hostAccess },
	);
	if ("error" in result) {
		return apiError(result.error);
	}
	const { registryPasswordEnc, ...rest } = result.parsed;
	await job.update({
		...rest,
		...(registryPasswordEnc ? { registryPasswordEnc } : {}),
	});
	return Response.json(cronJobApiJson(job.toJSON()));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const job = await ownJob(
		params.cronJobId,
		can(caller.permissions, "system", "write"),
	);
	if (job instanceof Response) {
		return job;
	}
	await job.delete();
	return new Response(null, { status: 204 });
};
