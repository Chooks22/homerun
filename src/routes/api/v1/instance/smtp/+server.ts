import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { smtpSettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.smtpSettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, smtpSettingsApiBody, {
		read: () => SettingsApiService.smtpSettings(),
		save: (body, userId) => SettingsApiService.patchSmtpSettings(body, userId),
	});
