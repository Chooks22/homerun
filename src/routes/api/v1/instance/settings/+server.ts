import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { instanceSettingsApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.instanceSettings());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, instanceSettingsApiBody, {
		read: () => SettingsApiService.instanceSettings(),
		save: (body, userId) =>
			SettingsApiService.patchInstanceSettings(body, userId),
	});
