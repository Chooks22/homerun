import { fail } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { TraceSpanDTO } from "#lib/dto/trace-span-dto.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { TracingService } from "#lib/services/tracing.service.js";
import { OTEL_COLLECTOR_HOST, OTEL_HTTP_PORT } from "#lib/tracing/env.js";
import { TRACE_FILTER_KEYS, TRACE_SORT_KEYS } from "#lib/tracing/list.js";

const logger = new Logger("Tracing");

export const load = async ({ parent, url }) => {
	const { preferences, service } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: TRACE_FILTER_KEYS, sortKeys: TRACE_SORT_KEYS },
		preferences.perPage,
	);
	const settings = await TracingService.settings();
	return {
		collectorEnabled: settings.collectorEnabled,
		endpoint: `http://${OTEL_COLLECTOR_HOST}:${OTEL_HTTP_PORT}`,
		listing: TraceSpanDTO.listTraces({ serviceId: service.id }, query),
		retentionDays: settings.retentionDays,
		searched: query.active,
	};
};

export const actions = {
	settings: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const tracesEnabled =
			(await request.formData()).get("tracesEnabled") === "on";
		const changed = svc.toJSON().tracesEnabled !== tracesEnabled;
		await svc.update({ tracesEnabled });
		TracingService.forgetServices();
		logger.info(
			`Traces ${tracesEnabled ? "enabled" : "disabled"}: service=${svc.id} user=${locals.user.id}`,
		);
		return { changed, tracesEnabled };
	},
};
