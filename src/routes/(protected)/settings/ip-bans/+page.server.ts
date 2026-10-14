import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import {
	DEFAULT_IP_BAN_SETTINGS,
	MAX_BAN_WINDOW_MINUTES,
} from "#lib/ip-bans.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";
import { resolve } from "$app/paths";

export const load = async () => {
	const settings = await InstanceSettingsDTO.get();
	return {
		crowdsec: settings.crowdsec,
		defaults: DEFAULT_IP_BAN_SETTINGS,
		ipBans: settings.ipBans,
		maxWindowMinutes: MAX_BAN_WINDOW_MINUTES,
		published: Boolean(config.traefik.dynamicConfigDir),
	};
};

export const actions = {
	updateIpBans: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const whole = (name: string) =>
			Number(String(formData.get(name) ?? "").trim());
		try {
			await InstanceSettingsService.saveIpBans(
				{
					disrespectMode: formData.get("disrespectMode") === "on",
					durationHours: whole("durationHours"),
					enabled: formData.get("enabled") === "on",
					meanMode: formData.get("meanMode") === "on",
					threshold: whole("threshold"),
					windowMinutes: whole("windowMinutes"),
				},
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { success: true };
	},
	updateCrowdsec: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const url = String(formData.get("crowdsecUrl") ?? "").trim();
		try {
			await InstanceSettingsService.saveCrowdsec(
				url
					? {
							machineId: String(formData.get("crowdsecMachineId") ?? "").trim(),
							password: String(formData.get("crowdsecPassword") ?? "") || null,
							url,
						}
					: null,
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { success: true };
	},
};
