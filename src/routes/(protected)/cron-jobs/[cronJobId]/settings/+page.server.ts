import { fail, redirect } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import {
	manageableCronJob,
	parseCronJobSection,
} from "#lib/server/cron-job-form.js";
import { resolve } from "$app/paths";

const logger = new Logger("CronJob");

export const actions = {
	delete: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const found = await manageableCronJob(params.cronJobId, locals.permissions);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		await found.job.delete();
		logger.info(`Cron job deleted: job=${found.job.id} user=${locals.user.id}`);
		redirect(303, resolve("cron-jobs"));
	},

	update: async ({ params, request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const found = await manageableCronJob(params.cronJobId, locals.permissions);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		const result = parseCronJobSection(
			found.job.toJSON(),
			await request.formData(),
			"settings",
			{ hostAccess: can(locals.permissions, "system", "write") },
		);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		const { registryPasswordEnc: _password, ...rest } = result.parsed;
		await found.job.update(rest);
		logger.info(
			`Cron job settings updated: job=${found.job.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
