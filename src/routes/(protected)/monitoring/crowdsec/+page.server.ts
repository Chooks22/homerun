import { fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { can, permissionDeniedMessage } from "#lib/permissions.js";
import { type ListQuery, parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";

const logger = new Logger("CrowdSec");

/** One page of the LAPI's own decisions in force, or why they couldn't be read. */
async function decisionsPage(query: ListQuery) {
	try {
		return { ...(await CrowdsecService.activeDecisions(query)), error: null };
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : "Couldn't reach CrowdSec.",
			items: [],
			total: 0,
			truncated: false,
		};
	}
}

export const load = async ({ parent, url }) => {
	const { crowdsecConfigured, preferences } = await parent();
	const query = parseListQuery(url, {}, preferences.perPage);
	return {
		decisions: crowdsecConfigured ? decisionsPage(query) : null,
		page: query.page,
		perPage: query.perPage,
	};
};

export const actions = {
	deleteDecision: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!can(locals.permissions, "settings", "write")) {
			return fail(403, { error: permissionDeniedMessage("settings", "write") });
		}
		const id = Number((await request.formData()).get("id"));
		if (!(Number.isInteger(id) && id > 0)) {
			return fail(400, { error: "That isn't a decision id." });
		}
		try {
			await CrowdsecService.deleteDecision(id);
		} catch (err) {
			return fail(502, {
				error: err instanceof Error ? err.message : "CrowdSec refused.",
			});
		}
		logger.info(`CrowdSec decision deleted: id=${id} user=${locals.user.id}`);
		return { success: true };
	},
};
