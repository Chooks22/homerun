import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { tlsSettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.tlsSettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, tlsSettingsApiBody, {
		read: () => SettingsApiService.tlsSettings(),
		save: (body, userId) => SettingsApiService.patchTlsSettings(body, userId),
	});
