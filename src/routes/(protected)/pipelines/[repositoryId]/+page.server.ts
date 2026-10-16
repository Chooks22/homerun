import { error, redirect } from "@sveltejs/kit";
import { PipelineRunDTO } from "#lib/dto/pipeline-run-dto.js";
import { RepositoryDTO } from "#lib/dto/repository-dto.js";
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
	const { preferences, repository } = await parent();
	const repo = await RepositoryDTO.get(repository.id);
	if (!repo) {
		error(404, "Repository not found");
	}
	const query = parseListQuery(
		url,
		{ filterKeys: PIPELINE_FILTER_KEYS, sortKeys: PIPELINE_SORT_KEYS },
		preferences.perPage,
	);
	return {
		listing: PipelineRunDTO.list(repository.id, query),
		overview: await PipelineService.overview(repo),
		searched: query.active,
		windowDays: STATS_WINDOW_DAYS,
	};
};

export const actions = {
	sync: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const repo = await RepositoryDTO.get(params.repositoryId);
		if (!repo) {
			error(404, "Repository not found");
		}
		return { jobId: await PipelineService.enqueueSync(repo, locals.user.id) };
	},
};
