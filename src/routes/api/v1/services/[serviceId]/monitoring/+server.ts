import { ServiceDTO } from "#lib/dto/service-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import {
	monitoringQuery,
	monitoringTotals,
	recentUptime,
} from "#lib/server/monitoring-api.js";
import { MonitoringService } from "#lib/services/monitoring.service.js";

export const GET = async ({ locals, params, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const svc = await ServiceDTO.get(params.serviceId);
	if (!svc) {
		return apiError("Not found", 404);
	}
	const query = monitoringQuery(url);
	if (!query) {
		return apiError(
			"range must be today, week, month, year or all, and zone an IANA time zone.",
		);
	}
	const [summary, uptime] = await Promise.all([
		MonitoringService.forService(svc.id, query.range, query.zone),
		recentUptime(svc.id),
	]);
	return Response.json({
		...monitoringTotals(summary),
		uptime,
		uptimeEnabled: svc.uptimeEnabled,
	});
};
