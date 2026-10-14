import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ResourceIncidentDTO } from "#lib/dto/resource-incident-dto.js";
import { Logger } from "#lib/logger.js";
import { passkeyRpId } from "#lib/security-policy.js";
import {
	checkbox,
	nullableText,
} from "#lib/server/validation/instance-settings-form.js";
import { AccountSecurityService } from "#lib/services/account-security.service.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";
import { isUiMode } from "#lib/ui-mode.js";
import { isUpdateChannel } from "#lib/update-channel.js";
import { resolve } from "$app/paths";

const logger = new Logger("InstanceSettings");

export const load = async ({ parent }) => {
	await parent();
	const [settings, incidents] = await Promise.all([
		InstanceSettingsDTO.get(),
		ResourceIncidentDTO.recent(10),
	]);
	return {
		passkeyCount: await AccountSecurityService.countAllPasskeys(),
		resourceAlertTiming: {
			reminderMinutes: settings.resourceAlertReminderMinutes,
			sustainSeconds: settings.resourceAlertSustainSeconds,
		},
		resourceIncidents: incidents.map((incident) => incident.toJSON()),
		resourceThresholds: settings.resourceThresholds,
		passkeyRpId: passkeyRpId(config.auth.origin) ?? "localhost",
	};
};

export const actions = {
	updateCore: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		try {
			await InstanceSettingsService.saveCore(
				{
					authCheckUrl: nullableText(formData, "authCheckUrl"),
					authCrossSubdomainCookies: checkbox(
						formData,
						"authCrossSubdomainCookies",
					),
					baseDomain: nullableText(formData, "baseDomain"),
					dashboardUrl: nullableText(formData, "authOrigin"),
					useHttps: checkbox(formData, "useHttps"),
				},
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message, savedSection: "core" });
			}
			throw err;
		}
		return { savedSection: "core", success: true };
	},

	updateChannel: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const channel = formData.get("updateChannel");
		if (!isUpdateChannel(channel)) {
			return fail(400, {
				error: "Pick the stable, canary or nightly channel.",
				savedSection: "channel",
			});
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateUpdateChannel(channel);
		logger.info(
			`Update channel set: channel=${channel} user=${locals.user.id}`,
		);
		return { savedSection: "channel", success: true };
	},

	updateUiMode: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const mode = (await request.formData()).get("defaultUiMode");
		if (!isUiMode(mode)) {
			return fail(400, {
				error: "Pick simple or advanced.",
				savedSection: "uiMode",
			});
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.updateDefaultUiMode(mode);
		logger.info(`Default UI mode set: mode=${mode} user=${locals.user.id}`);
		return { savedSection: "uiMode", success: true };
	},

	updateResources: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		try {
			await InstanceSettingsService.saveResources(
				(name) => formData.get(name) as string | null,
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message, savedSection: "resources" });
			}
			throw err;
		}
		return { savedSection: "resources", success: true };
	},
};
