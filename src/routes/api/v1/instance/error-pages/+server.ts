import { patchSettings, readSettings } from "#lib/server/settings-route.js";
import { errorPagesApiBody } from "#lib/server/validation/settings-api.js";
import { SettingsApiService } from "#lib/services/settings-api.service.js";

export const GET = async ({ locals }) =>
	await readSettings(locals, () => SettingsApiService.errorPages());

export const PATCH = async ({ locals, request }) =>
	await patchSettings(locals, request, errorPagesApiBody, {
		read: () => SettingsApiService.errorPages(),
		save: (body, userId) => SettingsApiService.patchErrorPages(body, userId),
	});
