import { ServiceDTO } from "#lib/dto/service-dto.js";
import { rangeStart } from "#lib/monitoring-ranges.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import {
	monitoringQuery,
	monitoringTotals,
} from "#lib/server/monitoring-api.js";
import { MonitoringService } from "#lib/services/monitoring.service.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const query = monitoringQuery(url);
	if (!query) {
		return apiError(
			"range must be today, week, month, year or all, and zone an IANA time zone.",
		);
	}
	const services = await ServiceDTO.list();
	const serviceIds = services.map((svc) => svc.id);
	const names = new Map(services.map((svc) => [svc.id, svc.name]));
	const [summary, breakdown] = await Promise.all([
		MonitoringService.forScope(
			{ resources: "host", serviceIds },
			query.range,
			query.zone,
		),
		MonitoringService.breakdown(
			serviceIds,
			rangeStart(query.range, new Date(), query.zone),
		),
	]);
	return Response.json({
		...monitoringTotals(summary),
		services: breakdown.map((row) => ({
			...row,
			name: names.get(row.serviceId) ?? row.serviceId,
		})),
	});
};
