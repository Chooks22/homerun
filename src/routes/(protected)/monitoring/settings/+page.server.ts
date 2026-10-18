import { fail, redirect } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { can, permissionDeniedMessage } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { TracingService } from "#lib/services/tracing.service.js";
import {
	MAX_TRACE_RETENTION_DAYS,
	MIN_TRACE_RETENTION_DAYS,
	parseRetentionDays,
} from "#lib/tracing/settings.js";
import { resolve } from "$app/paths";

const logger = new Logger("Tracing");

export const load = async ({ locals, parent }) => {
	await parent();
	if (!can(locals.permissions, "settings", "read")) {
		throw redirect(302, resolve("monitoring"));
	}
	return {
		limits: { max: MAX_TRACE_RETENTION_DAYS, min: MIN_TRACE_RETENTION_DAYS },
		status: await TracingService.collectorStatus(),
	};
};

export const actions = {
	save: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!can(locals.permissions, "settings", "write")) {
			return fail(403, { error: permissionDeniedMessage("settings", "write") });
		}
		const formData = await request.formData();
		const retentionDays = parseRetentionDays(formData.get("retentionDays"));
		if (retentionDays === null) {
			return fail(400, {
				errors: {
					retentionDays: [
						`Keep traces between ${MIN_TRACE_RETENTION_DAYS} and ${MAX_TRACE_RETENTION_DAYS} days.`,
					],
				},
			});
		}
		const collectorEnabled = formData.get("collectorEnabled") === "on";
		try {
			await TracingService.saveSettings({ collectorEnabled, retentionDays });
		} catch (error) {
			logger.error("Couldn't apply the tracing settings", error);
			return fail(500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		logger.info(
			`Tracing settings saved by user=${locals.user.id}: collector=${collectorEnabled} retention=${retentionDays}d`,
		);
		return { collectorEnabled };
	},
};
