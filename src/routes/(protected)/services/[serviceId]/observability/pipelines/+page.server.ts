import { fail, redirect } from "@sveltejs/kit";
import { PipelineRunDTO } from "#lib/dto/pipeline-run-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { formatRates } from "#lib/pipelines/cost.js";
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
	const { preferences, service } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: PIPELINE_FILTER_KEYS, sortKeys: PIPELINE_SORT_KEYS },
		preferences.perPage,
	);
	const svc = await ServiceDTO.get(service.id);
	const overview = svc ? await PipelineService.overview(svc) : null;
	return {
		listing: PipelineRunDTO.list(service.id, query),
		overview,
		ratesText: overview ? formatRates(overview.rates) : "",
		searched: query.active,
		windowDays: STATS_WINDOW_DAYS,
	};
};

export const actions = {
	settings: async ({ request, params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const form = await request.formData();
		const enabled = form.get("pipelinesEnabled") === "on";
		try {
			await PipelineService.saveSettings(svc, {
				enabled,
				rates: String(form.get("rates") ?? ""),
			});
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : "Couldn't save.",
			});
		}
		if (enabled) {
			void PipelineService.sync(svc).catch(() => undefined);
		}
		return { enabled };
	},
	sync: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			return await PipelineService.sync(svc);
		} catch (err) {
			return fail(502, {
				error: err instanceof Error ? err.message : "Couldn't sync.",
			});
		}
	},
};
