import { fail } from "@sveltejs/kit";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { Logger } from "#lib/logger.js";
import { parseRedirectInput } from "#lib/server/redirect-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { RedirectService } from "#lib/services/redirect.service.js";

const logger = new Logger("Redirects");

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const result = await parseRedirectInput(
			Object.fromEntries(await request.formData()),
		);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}

		const created = await RedirectDTO.create({
			...result.fields,
			userId: locals.user.id,
		});
		await RedirectService.sync();
		logger.info(
			`Redirect created: redirect=${created.toJSON().id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
