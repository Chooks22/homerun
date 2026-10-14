import { fail, redirect } from "@sveltejs/kit";
import { nullableText } from "#lib/server/validation/instance-settings-form.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";
import { resolve } from "$app/paths";

export const actions = {
	updateTraefik: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		try {
			const traefikDetail = await InstanceSettingsService.saveTraefik(
				{
					traefikAcmeEmail: nullableText(formData, "traefikAcmeEmail"),
					traefikCertResolver: nullableText(formData, "traefikCertResolver"),
					traefikDynamicConfigDir: nullableText(
						formData,
						"traefikDynamicConfigDir",
					),
					traefikEntrypoint: nullableText(formData, "traefikEntrypoint"),
					traefikHttpCache: formData.get("traefikHttpCache") === "on",
				},
				locals.user.id,
			);
			return { savedSection: "traefik", success: true, traefikDetail };
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
	},
};
