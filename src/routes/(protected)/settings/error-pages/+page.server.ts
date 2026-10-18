import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { DEFAULT_ERROR_PAGES } from "#lib/error-pages.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";

export const load = async () => {
	const settings = await InstanceSettingsDTO.get();
	return {
		defaults: DEFAULT_ERROR_PAGES,
		errorPages: settings.toJSON().errorPages ?? {},
		published: Boolean(config.traefik.dynamicConfigDir),
	};
};

function text(formData: FormData, name: string, max: number): string | null {
	const value = String(formData.get(name) ?? "").trim();
	return value ? value.slice(0, max) : null;
}

export const actions = {
	updateBranding: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		try {
			await InstanceSettingsService.saveErrorPageBranding(
				{
					accentColor: text(formData, "accentColor", 7),
					brandName: text(formData, "brandName", 60),
					logoUrl: text(formData, "logoUrl", 2000),
					showPoweredBy: formData.get("showPoweredBy") === "on",
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

	updateText: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		await InstanceSettingsService.saveErrorPageTexts(
			await request.formData(),
			locals.user.id,
		);
		return { success: true };
	},
};
