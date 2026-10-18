import { fail } from "@sveltejs/kit";
import { AppLogDTO } from "#lib/dto/app-log-dto.js";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { UptimeCheckDTO } from "#lib/dto/uptime-check-dto.js";
import { Logger } from "#lib/logger.js";
import { rangeStart } from "#lib/monitoring-ranges.js";
import { can } from "#lib/permissions.js";
import { describeReading } from "#lib/resource-thresholds.js";
import { monitoringRequest } from "#lib/server/monitoring-request.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { CapacityService } from "#lib/services/capacity.service.js";
import { MonitoringService } from "#lib/services/monitoring.service.js";
import { isProbed } from "#lib/services/uptime/uptime-probe.js";
import { SIMPLE_FRONT_PAGE_TEMPLATES } from "#lib/ui-mode.js";
import { resolve } from "$app/paths";

const logger = new Logger("Dashboard");

/** The front page's one-click templates, in `SIMPLE_FRONT_PAGE_TEMPLATES` order, skipping any this instance doesn't have. */
async function frontPageTemplates() {
	const templates = new Map(
		(await TemplateDTO.list()).map((tmpl) => [tmpl.id, tmpl.toJSON()]),
	);
	return SIMPLE_FRONT_PAGE_TEMPLATES.flatMap((id) => {
		const tmpl = templates.get(id);
		return tmpl
			? [
					{
						category: tmpl.category,
						description: tmpl.description,
						icon: tmpl.icon,
						id: tmpl.id,
						name: tmpl.name,
					},
				]
			: [];
	});
}

/** Today's traffic, uptime and host use, and the five busiest services, for the dashboard's summary. */
async function todaysMonitoring(services: ServiceDTO[], zone: string) {
	const serviceIds = services.map((svc) => svc.id);
	const [monitoring, breakdown] = await Promise.all([
		MonitoringService.forScope(
			{ resources: "host", serviceIds },
			"today",
			zone,
		),
		MonitoringService.breakdown(
			serviceIds,
			rangeStart("today", new Date(), zone),
		),
	]);
	const names = new Map(services.map((svc) => [svc.id, svc.name]));
	return {
		busiest: breakdown
			.filter((row) => row.requests > 0)
			.slice(0, 5)
			.map((row) => ({
				...row,
				href: resolve("/(protected)/services/[serviceId]/observability", {
					serviceId: row.serviceId,
				}),
				name: names.get(row.serviceId) ?? row.serviceId,
			})),
		monitoring,
	};
}

export const load = async ({ cookies, locals, parent, url }) => {
	// (protected)/+layout.server.ts already redirects unauthenticated users
	// before this load runs : parent() gives the already-guaranteed user.
	const { uiMode } = await parent();

	const readsServices = can(locals.permissions, "services");
	const [services, recentDeployments, uptime, hardBreaches, templates] =
		await Promise.all([
			readsServices ? ServiceDTO.list() : [],
			readsServices ? DeploymentDTO.listRecent() : [],
			readsServices ? UptimeCheckDTO.latest() : [],
			CapacityService.hardBreaches(),
			uiMode === "simple" && can(locals.permissions, "services", "write")
				? frontPageTemplates()
				: [],
		]);
	const recentErrors = can(locals.permissions, "system")
		? await AppLogDTO.listRecent(5)
		: await AppLogDTO.listRecentForServices(
				services.map((svc) => svc.id),
				5,
			);
	const serviceNames = new Map(services.map((svc) => [svc.id, svc.name]));
	const probed = new Set(
		services.filter((svc) => isProbed(svc.toJSON())).map((svc) => svc.id),
	);
	const live = uptime.filter((check) => probed.has(check.serviceId));

	return {
		frontPageTemplates: templates,
		readsSettings: can(locals.permissions, "settings"),
		readsSystem: can(locals.permissions, "system"),
		monitoring: todaysMonitoring(
			services,
			monitoringRequest(url, cookies).zone,
		),
		overCapacity: hardBreaches.map(describeReading),
		recentDeployments: recentDeployments.map((r) => ({
			...r.deployment.toJSON(),
			serviceName: r.serviceName,
			serviceSlug: r.serviceSlug,
		})),
		recentErrors: recentErrors.map((log) => {
			const row = log.toJSON();
			return {
				createdAt: row.createdAt,
				id: row.id,
				level: row.level,
				message: row.message,
				scope: row.scope,
				serviceId: row.serviceId,
				serviceName: row.serviceId
					? (serviceNames.get(row.serviceId) ?? null)
					: null,
			};
		}),
		stats: {
			running: services.filter((s) => s.currentStatus === "running").length,
			totalServices: services.length,
		},
		// One row per failing probe, newest first : the dashboard shows what's
		// down, not a roll-call of everything that's fine.
		uptimeDown: live
			.filter((check) => !check.ok)
			.map((check) => ({
				detail: check.detail,
				kind: check.kind,
				serviceId: check.serviceId,
				serviceName: serviceNames.get(check.serviceId) ?? "Unknown service",
				target: check.target,
			})),
		uptimeProbes: live.length,
	};
};

export const actions = {
	clearErrors: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!can(locals.permissions, "services", "write")) {
			return fail(403, { error: "Needs write access to Services." });
		}
		if (can(locals.permissions, "system", "write")) {
			await AppLogDTO.clear();
		} else {
			const services = await ServiceDTO.list();
			await AppLogDTO.clear(services.map((svc) => svc.id));
		}
		logger.info(`Recent errors cleared: user=${locals.user.id}`);
		return { success: true };
	},
};
