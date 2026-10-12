import { fail, redirect } from "@sveltejs/kit";
import { normalizeIp } from "#lib/ip-bans.js";
import { Logger } from "#lib/logger.js";
import { can, permissionDeniedMessage } from "#lib/permissions.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("CrowdSec");

export const load = async ({ locals, parent }) => {
	await parent();
	if (!can(locals.permissions, "settings", "write")) {
		throw redirect(302, resolve("/(protected)/monitoring/crowdsec"));
	}
	return {};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		if (!can(locals.permissions, "settings", "write")) {
			return fail(403, { error: permissionDeniedMessage("settings", "write") });
		}
		const formData = await request.formData();
		const ip = normalizeIp(String(formData.get("ip") ?? ""));
		const durationHours = Number(String(formData.get("durationHours") ?? ""));
		const reason = String(formData.get("reason") ?? "").trim() || "manual ban";
		if (!ip) {
			return fail(400, { error: "That isn't an IP address." });
		}
		if (
			!(Number.isInteger(durationHours) && durationHours >= 0) ||
			durationHours > 8760
		) {
			return fail(400, {
				error: "The ban length must be 0 (ten years) to 8760 hours.",
			});
		}
		try {
			await CrowdsecService.addDecision({ durationHours, ip, reason });
		} catch (err) {
			return fail(502, {
				error: err instanceof Error ? err.message : "CrowdSec refused.",
			});
		}
		logger.info(`CrowdSec decision added: ip=${ip} user=${locals.user.id}`);
		redirect(303, resolve("/(protected)/monitoring/crowdsec"));
	},
};
