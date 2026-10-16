import { redirect } from "@sveltejs/kit";
import { PipelineRunDTO } from "#lib/dto/pipeline-run-dto.js";
import {
	PIPELINE_FILTER_KEYS,
	PIPELINE_SORT_KEYS,
} from "#lib/pipelines/list.js";
import { parseListQuery } from "#lib/server/list-query.js";
import {
	PipelineService,
	STATS_WINDOW_DAYS,
} from "#lib/services/pipeline.service.js";
import { resolve } from "$app/paths";

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: PIPELINE_FILTER_KEYS, sortKeys: PIPELINE_SORT_KEYS },
		preferences.perPage,
	);
	return {
		listing: PipelineRunDTO.list(null, query),
		overview: await PipelineService.globalOverview(),
		searched: query.active,
		windowDays: STATS_WINDOW_DAYS,
	};
};

export const actions = {
	syncAll: async ({ locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const jobIds = await PipelineService.enqueueSyncAll(locals.user.id);
		return { jobId: jobIds[0] ?? null, queued: jobIds.length };
	},
};
