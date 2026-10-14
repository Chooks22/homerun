import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { registrySettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.registrySettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, registrySettingsApiBody, {
		read: () => SettingsApiService.registrySettings(),
		save: (body, userId) =>
			SettingsApiService.patchRegistrySettings(body, userId),
	});
