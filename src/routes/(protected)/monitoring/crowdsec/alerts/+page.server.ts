import { type ListQuery, parseListQuery } from "#lib/server/list-query.js";
import { CrowdsecService } from "#lib/services/crowdsec.service.js";

/** One page of the last day's alerts, or why they couldn't be read. */
async function alertsPage(query: ListQuery) {
	try {
		return { ...(await CrowdsecService.recentAlerts(query)), error: null };
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
		alerts: crowdsecConfigured ? alertsPage(query) : null,
		page: query.page,
		perPage: query.perPage,
	};
};
