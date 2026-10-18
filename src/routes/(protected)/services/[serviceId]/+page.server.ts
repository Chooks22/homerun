import { fail } from "@sveltejs/kit";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { ServiceDependencyDTO } from "#lib/dto/service-dependency-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { linkKeys } from "#lib/service-graph.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import { DockerService } from "#lib/services/docker.service.js";
import { RevisionService } from "#lib/services/revision.service.js";
import { ServiceLifecycleService } from "#lib/services/service-lifecycle.service.js";

const logger = new Logger("Services");

function lifecycleFailure(verb: string, error: unknown) {
	logger.error(`Failed to ${verb} service`, error);
	const reason = error instanceof Error ? error.message : "unknown error";
	return fail(500, {
		error: `Couldn't ${verb} the service : ${reason}. If its container was removed outside Homerun, resolve it from the Errors tab first.`,
	});
}

export const load = async ({ params, parent }) => {
	const { service: svc, uiMode } = await parent();
	const [deployments, siblings, recorded, revisions] = await Promise.all([
		DeploymentDTO.listForService(params.serviceId),
		ServiceDTO.list(),
		ServiceDependencyDTO.map(),
		uiMode === "simple" ? RevisionService.list(svc) : [],
	]);

	const others = siblings.filter((other) => other.id !== params.serviceId);
	const dependsOn = others
		.map((other) => ({
			id: other.id,
			keys: linkKeys(svc.envVars, other.slug),
			name: other.name,
			slug: other.slug,
		}))
		.filter(
			(other) =>
				other.keys.length > 0 ||
				(recorded.get(params.serviceId) ?? []).includes(other.id),
		);
	const usedBy = others
		.map((other) => ({
			id: other.id,
			keys: linkKeys(other.envVars, svc.slug),
			name: other.name,
			slug: other.slug,
		}))
		.filter(
			(other) =>
				other.keys.length > 0 ||
				(recorded.get(other.id) ?? []).includes(params.serviceId),
		);

	return {
		canRollBack: revisions.some((revision) => revision.previous),
		dependsOn,
		deployments: deployments.map((d) => d.toJSON()),
		usedBy,
	};
};

export const actions = {
	/**
	 * Unlinks this service from `targetId`: drops its recorded dependency on
	 * the target and every env var whose value points at the target's host
	 * (and its secret mark), so the two stop showing as connected. The env
	 * change applies on the next deploy.
	 */
	unlink: async ({ params, locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const targetId = (await request.formData()).get("targetId");
		const [svc, target] = await Promise.all([
			ServiceDTO.get(params.serviceId),
			typeof targetId === "string" ? ServiceDTO.get(targetId) : null,
		]);
		if (!(svc && target)) {
			return fail(404, { error: "Service not found." });
		}
		const removed = linkKeys(svc.envVars, target.slug);
		const hadDependency = await ServiceDependencyDTO.remove(svc.id, target.id);
		if (removed.length === 0 && !hadDependency) {
			return fail(400, {
				error: `${svc.name} doesn't point at ${target.name}.`,
			});
		}
		if (removed.length > 0) {
			await svc.update({
				envVars: Object.fromEntries(
					Object.entries(svc.envVars).filter(([key]) => !removed.includes(key)),
				),
				secretEnvKeys: svc.secretEnvKeys.filter(
					(key) => !removed.includes(key),
				),
			});
		}
		logger.info(
			`Service unlinked: service=${svc.id} target=${target.id} vars=${removed.join(",")} user=${locals.user.id}`,
		);
		return { removed, success: true };
	},
	deploy: async ({ params, locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		// The client pre-generates this id so it can start polling the
		// progress endpoint immediately, before this request even resolves.
		const formData = await request.formData();
		const clientDeploymentId = formData.get("deploymentId") as string | null;

		const { deploymentId } = await DeploymentService.enqueueDeploy({
			clientDeploymentId,
			noCache: formData.get("noCache") === "1",
			svc,
			userId: locals.user.id,
		});

		return { deploymentId, success: true };
	},

	rollback: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const target = await RevisionService.findTarget(svc, null);
		if (target.error !== null) {
			return fail(target.status, { error: target.error });
		}
		const { deploymentId } = await RevisionService.enqueueRollback({
			revision: target.revision,
			svc,
			userId: locals.user.id,
		});
		logger.info(
			`Rollback queued: service=${svc.id} revision=${target.revision.id} deployment=${deploymentId} user=${locals.user.id}`,
		);
		return { deploymentId, success: true };
	},

	cancel: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const [latest] = await DeploymentDTO.listForService(params.serviceId, 1);
		const status = latest?.toJSON().status;
		if (
			!latest ||
			!(status === "pending" || status === "pulling" || status === "starting")
		) {
			return fail(409, { error: "Nothing is deploying right now." });
		}
		await latest.appendLog("Cancelled.");
		await latest.update({
			errorMessage: "Cancelled.",
			finishedAt: new Date(),
			status: "failed",
		});
		await JobDTO.cancelForDeployment(
			latest.id,
			"Cancelled from the dashboard.",
		);
		await DockerService.syncServiceStatus(params.serviceId).catch((error) => {
			logger.warn(
				"Couldn't refresh the service's status after a cancel",
				error,
			);
		});
		logger.info(
			`Deploy cancelled: service=${params.serviceId} deployment=${latest.id} user=${locals.user.id}`,
		);
		return { success: true };
	},

	kill: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			await ServiceLifecycleService.killService(svc);
		} catch (error) {
			return lifecycleFailure("kill", error);
		}
		logger.info(`Service killed: service=${svc.id} user=${locals.user.id}`);
		NotificationDTO.notify({
			message: `"${svc.name}" was killed.`,
			serviceId: svc.id,
			type: "service_stopped",
		});
		return { success: true };
	},

	pull: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			const { changed } = await ServiceLifecycleService.pullServiceImage(svc);
			logger.info(
				`Image pulled: service=${svc.id} changed=${changed} user=${locals.user.id}`,
			);
			return {
				message: changed
					? `Pulled a newer ${svc.image}:${svc.tag}, redeploy to run it.`
					: `${svc.image}:${svc.tag} is already up to date.`,
				success: true,
			};
		} catch (error) {
			logger.error("Failed to pull service image", error);
			return fail(500, {
				error: `Couldn't pull ${svc.image}:${svc.tag} : ${error instanceof Error ? error.message : "unknown error"}.`,
			});
		}
	},

	restart: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			await ServiceLifecycleService.restartService(svc);
		} catch (error) {
			return lifecycleFailure("restart", error);
		}
		logger.info(`Service restarted: service=${svc.id} user=${locals.user.id}`);
		return { success: true };
	},

	start: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			await ServiceLifecycleService.startService(svc);
		} catch (error) {
			return lifecycleFailure("start", error);
		}
		logger.info(`Service started: service=${svc.id} user=${locals.user.id}`);
		NotificationDTO.notify({
			message: `"${svc.name}" was started.`,
			serviceId: svc.id,
			type: "service_started",
		});
		return { success: true };
	},

	stop: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			await ServiceLifecycleService.stopService(svc);
		} catch (error) {
			return lifecycleFailure("stop", error);
		}
		logger.info(`Service stopped: service=${svc.id} user=${locals.user.id}`);
		NotificationDTO.notify({
			message: `"${svc.name}" was stopped.`,
			serviceId: svc.id,
			type: "service_stopped",
		});
		return { success: true };
	},
};
