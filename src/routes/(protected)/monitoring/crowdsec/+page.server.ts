import { fail, redirect } from "@sveltejs/kit";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import { can, permissionDeniedMessage } from "#lib/permissions.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("CrowdSec");

/** The LAPI's decisions in force and last day of alerts, or why they couldn't be read. */
async function crowdsecView() {
	try {
		const [active, alerts] = await Promise.all([
			CrowdsecService.activeDecisions(),
			CrowdsecService.recentAlerts(),
		]);
		return { ...active, alerts, error: null };
	} catch (err) {
		return {
			alerts: [],
			decisions: [],
			error: err instanceof Error ? err.message : "Couldn't reach CrowdSec.",
			truncated: false,
		};
	}
}

export const load = async ({ locals, parent }) => {
	await parent();
	if (!can(locals.permissions, "settings", "read")) {
		throw redirect(302, resolve("/(protected)/monitoring"));
	}
	const configured = Boolean(
		(await InstanceSettingsDTO.get()).crowdsecCredentials(),
	);
	return {
		canWrite: can(locals.permissions, "settings", "write"),
		configured,
		view: configured ? crowdsecView() : null,
	};
};

export const actions = {
	deleteDecision: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		if (!can(locals.permissions, "settings", "write")) {
			return fail(403, { error: permissionDeniedMessage("settings", "write") });
		}
		const id = Number((await request.formData()).get("id"));
		if (!(Number.isInteger(id) && id > 0)) {
			return fail(400, { error: "That isn't a decision id." });
		}
		try {
			await CrowdsecService.deleteDecision(id);
		} catch (err) {
			return fail(502, {
				error: err instanceof Error ? err.message : "CrowdSec refused.",
			});
		}
		logger.info(`CrowdSec decision deleted: id=${id} user=${locals.user.id}`);
		return { success: true };
	},
};
