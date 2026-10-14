import { AppLogDTO } from "#lib/dto/app-log-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const limit = Number(url.searchParams.get("limit") ?? 100);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		return apiError("limit must be a whole number from 1 to 500.");
	}
	const [logs, services] = await Promise.all([
		AppLogDTO.listRecent(limit),
		ServiceDTO.list(),
	]);
	const names = new Map(services.map((svc) => [svc.id, svc.name]));
	return Response.json(
		logs.map((log) => {
			const row = log.toJSON();
			return {
				...row,
				serviceName: row.serviceId ? (names.get(row.serviceId) ?? null) : null,
			};
		}),
	);
};
