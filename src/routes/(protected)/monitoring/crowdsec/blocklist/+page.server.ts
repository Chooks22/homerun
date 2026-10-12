import { type ListQuery, parseListQuery } from "#lib/server/list-query.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";

/** One page of the community blocklist matching the search, or why it couldn't be read. */
async function blocklistPage(query: ListQuery) {
	try {
		return { ...(await CrowdsecService.blocklist(query)), error: null };
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : "Couldn't reach CrowdSec.",
			items: [],
			total: 0,
		};
	}
}

export const load = async ({ parent, url }) => {
	const { crowdsecConfigured, preferences } = await parent();
	const query = parseListQuery(url, {}, preferences.perPage);
	return {
		blocklist: crowdsecConfigured ? blocklistPage(query) : null,
		page: query.page,
		perPage: query.perPage,
		searched: query.active,
	};
};
