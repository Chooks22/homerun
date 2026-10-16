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

export const load = async ({ parent, url }) => {
	const { preferences, service } = await parent();
	const repo = service.repositoryId
		? await RepositoryDTO.get(service.repositoryId)
		: null;
	if (!repo) {
		return { linked: null };
	}
	const query = parseListQuery(
		url,
		{ filterKeys: PIPELINE_FILTER_KEYS, sortKeys: PIPELINE_SORT_KEYS },
		preferences.perPage,
	);
	return {
		linked: {
			listing: PipelineRunDTO.list(repo.id, query),
			overview: await PipelineService.overview(repo),
			repository: repo.toJSON(),
			searched: query.active,
			windowDays: STATS_WINDOW_DAYS,
		},
	};
};
