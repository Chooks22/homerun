import { fail } from "@sveltejs/kit";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	RedirectService,
	redirectHost,
} from "#lib/services/redirect.service.js";

const logger = new Logger("Redirects");

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{ sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const paged = await RedirectDTO.listPaged(query);
	return {
		filtered: query.active,
		page: paged.page,
		perPage: paged.perPage,
		redirects: paged.items.map((r) => r.toJSON()),
		total: paged.total,
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const redirectId = formData.get("redirectId") as string | null;
		if (!redirectId) {
			return fail(400, { error: "Missing redirect id." });
		}

		const found = await RedirectDTO.get(redirectId);
		if (!found) {
			return fail(404, { error: "Redirect not found." });
		}

		const host = redirectHost(found.toJSON().source);
		await found.delete();
		await RedirectService.sync(host ? [host] : []);
		logger.info(
			`Redirect deleted: redirect=${redirectId} user=${locals.user.id}`,
		);
		return { success: true };
	},
	toggle: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const redirectId = formData.get("redirectId") as string | null;
		if (!redirectId) {
			return fail(400, { error: "Missing redirect id." });
		}

		const found = await RedirectDTO.get(redirectId);
		if (!found) {
			return fail(404, { error: "Redirect not found." });
		}

		const { enabled, source } = found.toJSON();
		await found.setEnabled(!enabled);
		const host = redirectHost(source);
		await RedirectService.sync(host ? [host] : []);
		logger.info(
			`Redirect ${enabled ? "disabled" : "enabled"}: redirect=${redirectId} user=${locals.user.id}`,
		);
		return { enabled: !enabled, success: true };
	},
};
