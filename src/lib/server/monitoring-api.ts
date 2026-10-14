import { UptimeCheckDTO } from "#lib/dto/uptime-check-dto.js";
import {
	isMonitoringRange,
	isTimeZone,
	type MonitoringRange,
} from "#lib/monitoring-ranges.js";
import type { MonitoringSummary } from "#lib/services/monitoring.service.js";

const RECENT_BEATS = 30;

/** The range (`?range=`, a week by default) and time zone (`?zone=`, UTC by default) a monitoring REST route asks for, or null when either isn't one. */
export function monitoringQuery(
	url: URL,
): { range: MonitoringRange; zone: string } | null {
	const range = url.searchParams.get("range") ?? "week";
	const zone = url.searchParams.get("zone") ?? "UTC";
	return isMonitoringRange(range) && isTimeZone(zone) ? { range, zone } : null;
}

/** A monitoring summary as the REST API returns it: the range's totals and the previous period's, without the chart series. */
export function monitoringTotals(summary: MonitoringSummary) {
	const {
		bucketSeconds: _bucket,
		resourceSeries: _resources,
		trafficSeries: _traffic,
		...totals
	} = summary;
	return totals;
}

/** The latest beats of a service's internal and external uptime probes, oldest first. */
export async function recentUptime(serviceId: string) {
	const [internal, external] = await Promise.all([
		UptimeCheckDTO.beats(serviceId, "internal", RECENT_BEATS),
		UptimeCheckDTO.beats(serviceId, "external", RECENT_BEATS),
	]);
	const strip = (beats: typeof internal) =>
		beats.map(({ serviceId: _service, ...beat }) => beat);
	return { external: strip(external), internal: strip(internal) };
}
