import { TraceSpanDTO } from "#lib/dto/trace-span-dto.js";

export const load = async ({ parent }) => {
	const { run } = await parent();
	const spans = run.jobId ? await TraceSpanDTO.spansOfJob(run.jobId) : [];
	return {
		traces: [...Map.groupBy(spans, (span) => span.traceId)].map(
			([traceId, traceSpans]) => ({ spans: traceSpans, traceId }),
		),
	};
};
