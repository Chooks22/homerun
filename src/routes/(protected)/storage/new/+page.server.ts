import { fail, redirect } from "@sveltejs/kit";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	VolumeSettingsError,
	VolumeSettingsService,
} from "#lib/services/volume-settings.service.js";
import { resolve } from "$app/paths";

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		try {
			await VolumeSettingsService.create(
				{
					description: formData.get("description") as string | null,
					kind: formData.get("kind") as string | null,
					name: (formData.get("name") as string | null) ?? "",
					source: (formData.get("source") as string | null) ?? "",
				},
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof VolumeSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		redirect(303, resolve("storage"));
	},
};
