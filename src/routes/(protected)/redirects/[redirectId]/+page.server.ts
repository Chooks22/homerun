import { error, fail } from "@sveltejs/kit";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { Logger } from "#lib/logger.js";
import { parseRedirectInput } from "#lib/server/redirect-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	RedirectService,
	redirectHost,
} from "#lib/services/redirect.service.js";

const logger = new Logger("Redirects");

export const load = async ({ params, parent }) => {
	await parent();

	const found = await RedirectDTO.get(params.redirectId);
	if (!found) {
		error(404, "Redirect not found");
	}

	return { redirect: found.toJSON() };
};

export const actions = {
	update: async ({ params, request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const found = await RedirectDTO.get(params.redirectId);
		if (!found) {
			return fail(404, { error: "Redirect not found." });
		}

		const result = await parseRedirectInput(
			Object.fromEntries(await request.formData()),
			params.redirectId,
		);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}

		const host = redirectHost(found.toJSON().source);
		await found.update(result.fields);
		await RedirectService.sync(host ? [host] : []);
		logger.info(
			`Redirect updated: redirect=${params.redirectId} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
