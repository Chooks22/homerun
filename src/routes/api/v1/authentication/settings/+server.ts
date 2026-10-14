import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { authenticationSettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.authenticationSettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, authenticationSettingsApiBody, {
		read: () => SettingsApiService.authenticationSettings(),
		save: (body) => SettingsApiService.patchAuthenticationSettings(body),
	});
