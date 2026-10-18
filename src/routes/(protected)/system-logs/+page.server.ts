import { fail } from "@sveltejs/kit";
import { AppLogDTO } from "#lib/dto/app-log-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { DockerService } from "#lib/services/docker.service.js";

const logger = new Logger("Traefik");

export const load = async () => {
	const [logs, services] = await Promise.all([
		AppLogDTO.listRecent(200),
		ServiceDTO.list(),
	]);
	const serviceNames = new Map(services.map((svc) => [svc.id, svc.name]));

	return {
		appLogs: logs.map((log) => {
			const row = log.toJSON();
			return {
				...row,
				serviceName: row.serviceId
					? (serviceNames.get(row.serviceId) ?? null)
					: null,
			};
		}),
	};
};

export const actions = {
	clearAppLogs: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		await AppLogDTO.clear();
		logger.info(`Application log cleared by user=${locals.user.id}`);
		return { action: "clearAppLogs", success: true };
	},

	restartTraefik: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		try {
			await DockerService.restartTraefikContainer();
			logger.info(`Traefik restarted by user=${locals.user.id}`);
			return { action: "restartTraefik", success: true };
		} catch (err) {
			logger.error("Failed to restart Traefik", err);
			return fail(500, {
				action: "restartTraefik",
				error:
					err instanceof Error ? err.message : "Failed to restart Traefik.",
			});
		}
	},

	updateTraefik: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		try {
			const result = await DockerService.updateTraefikContainer();
			logger.info(
				`Traefik update by user=${locals.user.id}: ${result.message}`,
			);
			return {
				action: "updateTraefik",
				message: result.message,
				success: true,
				updated: result.updated,
			};
		} catch (err) {
			logger.error("Failed to update Traefik", err);
			return fail(500, {
				action: "updateTraefik",
				error: err instanceof Error ? err.message : "Failed to update Traefik.",
			});
		}
	},
};
