import { error } from "@sveltejs/kit";
import { PipelineRunDTO } from "#lib/dto/pipeline-run-dto.js";
import { TraceSpanDTO } from "#lib/dto/trace-span-dto.js";

export const load = async ({ params, parent }) => {
	const { repository } = await parent();
	const dto = await PipelineRunDTO.getForRepository(
		repository.id,
		params.runId,
	);
	if (!dto) {
		error(404, "Run not found");
	}
	const run = dto.toJSON();
	return {
		runCrumb: {
			id: run.id,
			name: run.number === null ? run.name : `${run.name} #${run.number}`,
		},
		run,
		spans:
			run.traceExported && run.traceId
				? await TraceSpanDTO.spansOf(run.traceId)
				: [],
	};
};
