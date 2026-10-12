import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import {
	DEFAULT_IP_BAN_SETTINGS,
	MAX_BAN_WINDOW_MINUTES,
} from "#lib/ip-bans.js";
import { Logger } from "#lib/logger.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("IpBans");
const TRAILING_SLASHES_RE = /\/+$/;

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

function wholeNumber(
	formData: FormData,
	name: string,
	min: number,
	max: number,
): number | null {
	const value = Number(String(formData.get(name) ?? "").trim());
	return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export const actions = {
	updateIpBans: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const threshold = wholeNumber(formData, "threshold", 1, 1000);
		const windowMinutes = wholeNumber(
			formData,
			"windowMinutes",
			1,
			MAX_BAN_WINDOW_MINUTES,
		);
		const durationHours = wholeNumber(formData, "durationHours", 0, 8760);
		if (threshold === null) {
			return fail(400, { error: "Blocked requests must be 1 to 1000." });
		}
		if (windowMinutes === null) {
			return fail(400, {
				error: `The window must be 1 to ${MAX_BAN_WINDOW_MINUTES} minutes.`,
			});
		}
		if (durationHours === null) {
			return fail(400, {
				error: "The ban length must be 0 (forever) to 8760 hours.",
			});
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateIpBans({
			disrespectMode: formData.get("disrespectMode") === "on",
			durationHours,
			enabled: formData.get("enabled") === "on",
			meanMode: formData.get("meanMode") === "on",
			threshold,
			windowMinutes,
		});
		logger.info(`IP ban settings updated: user=${locals.user.id}`);
		return { success: true };
	},
	updateCrowdsec: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const rawUrl = String(formData.get("crowdsecUrl") ?? "").trim();
		const machineId = String(formData.get("crowdsecMachineId") ?? "").trim();
		const password = String(formData.get("crowdsecPassword") ?? "") || null;
		const settings = await InstanceSettingsDTO.get();
		if (!rawUrl) {
			await settings.updateCrowdsec(null);
			logger.info(`CrowdSec push turned off: user=${locals.user.id}`);
			return { success: true };
		}
		const url = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
		if (!(url && ["http:", "https:"].includes(url.protocol))) {
			return fail(400, { error: "The LAPI URL must be an http(s) URL." });
		}
		if (!machineId) {
			return fail(400, { error: "The machine id is required." });
		}
		const storedPassword = settings.crowdsecCredentials()?.password ?? null;
		if (!(password || storedPassword)) {
			return fail(400, { error: "The machine password is required." });
		}
		const credentials = {
			machineId,
			password: password ?? storedPassword ?? "",
			url: url.href.replace(TRAILING_SLASHES_RE, ""),
		};
		try {
			await CrowdsecService.login(credentials);
		} catch (err) {
			return fail(400, {
				error: `Couldn't log in to CrowdSec: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
		await settings.updateCrowdsec({ ...credentials, password });
		logger.info(`CrowdSec push configured: user=${locals.user.id}`);
		return { success: true };
	},
};
