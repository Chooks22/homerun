import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { ipBanSettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.ipBanSettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, ipBanSettingsApiBody, {
		read: () => SettingsApiService.ipBanSettings(),
		save: (body, userId) => SettingsApiService.patchIpBanSettings(body, userId),
	});
