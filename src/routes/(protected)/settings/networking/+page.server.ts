import { fail } from "@sveltejs/kit";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { nullableText } from "#lib/server/validation/instance-settings-form.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";

export const actions = {
	updateTraefik: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
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
