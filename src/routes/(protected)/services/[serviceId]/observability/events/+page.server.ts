import { fail } from "@sveltejs/kit";
import { AppLogDTO } from "#lib/dto/app-log-dto.js";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { UptimeCheckDTO } from "#lib/dto/uptime-check-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	externalHostFor,
	externalProbeSkipReason,
} from "#lib/services/uptime/uptime-probe.js";

const logger = new Logger("Services");

export const load = async ({ params, parent, url }) => {
	const { service: svc } = await parent();
	const showDismissed = url.searchParams.get("dismissed") === "1";
	const since = showDismissed ? null : svc.errorsDismissedAt;

	const [failedDeployments, appLogs, internal, external] = await Promise.all([
		DeploymentDTO.listFailedForService(params.serviceId, 50, since),
		AppLogDTO.listForService(params.serviceId, 50, since),
		UptimeCheckDTO.beats(params.serviceId, "internal"),
		UptimeCheckDTO.beats(params.serviceId, "external"),
	]);

	const dismissedCount = since
		? (
				await Promise.all([
					DeploymentDTO.countFailedForServiceUpTo(params.serviceId, since),
					AppLogDTO.countForServiceUpTo(params.serviceId, since),
				])
			).reduce((total, n) => total + n, 0)
		: 0;

	const dismissedBy = svc.errorsDismissedByDeploymentId
		? await DeploymentDTO.get(svc.errorsDismissedByDeploymentId)
		: null;

	const externalHost = externalHostFor(svc);
	return {
		appLogs: appLogs.map((l) => l.toJSON()),
		dismissedBy: dismissedBy
			? {
					createdAt: dismissedBy.toJSON().createdAt,
					gitCommit: dismissedBy.toJSON().gitCommit,
					id: dismissedBy.id,
					imageRef: dismissedBy.toJSON().imageRef,
				}
			: null,
		dismissedCount,
		externalSkipped: externalHost
			? externalProbeSkipReason(externalHost)
			: "This service isn't publicly routed, so there's no hostname to check.",
		failedDeployments: failedDeployments.map((d) => d.toJSON()),
		showDismissed,
		uptime: { external, internal },
	};
};

export const actions = {
	resolveOrphan: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		await svc.resolveOrphan();
		logger.info(
			`Orphaned container reference cleared: service=${svc.id} user=${locals.user.id}`,
		);
		return { success: true };
	},

	setUptime: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const uptimeEnabled = formData.get("uptimeEnabled") === "true";
		await svc.update({ uptimeEnabled });
		logger.info(
			`Uptime probing updated: service=${svc.id} enabled=${uptimeEnabled} user=${locals.user.id}`,
		);
		return { success: true, uptimeEnabled };
	},

	clearHeartbeats: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		await UptimeCheckDTO.clearForService(svc.id);
		logger.info(`Heartbeats cleared: service=${svc.id} user=${locals.user.id}`);
		return { success: true };
	},

	clearErrors: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		await svc.dismissErrors(null);
		logger.info(`Errors dismissed: service=${svc.id} user=${locals.user.id}`);
		return { success: true };
	},
};
