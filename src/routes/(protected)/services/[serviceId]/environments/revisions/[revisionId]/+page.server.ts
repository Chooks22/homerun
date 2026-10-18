import { error, fail, redirect } from "@sveltejs/kit";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { RevisionService } from "#lib/services/revision.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Revisions");

export const load = async ({ params, parent }) => {
	const { service } = await parent();
	const revisions = await RevisionService.history(service);
	const revision = revisions.find((entry) => entry.id === params.revisionId);
	if (!revision) {
		const deployment = await DeploymentDTO.getForService(
			service.id,
			params.revisionId,
		);
		const owner = deployment
			? revisions.find(
					(entry) =>
						entry.id === deployment.rollbackOfDeploymentId ||
						entry.latestDeploymentId === deployment.id,
				)
			: undefined;
		if (!deployment) {
			error(404, "Revision not found");
		}
		if (!owner) {
			redirect(
				307,
				resolve("/(protected)/services/[serviceId]/environments/revisions", {
					serviceId: service.id,
				}),
			);
		}
		redirect(
			307,
			resolve(
				"/(protected)/services/[serviceId]/environments/revisions/[revisionId]",
				{ revisionId: owner.id, serviceId: service.id },
			),
		);
	}
	const deployments = await DeploymentDTO.listForService(service.id, 30);
	return {
		deployments: deployments
			.map((deployment) => deployment.toJSON())
			.filter(
				(deployment) =>
					deployment.id === revision.id ||
					deployment.rollbackOfDeploymentId === revision.id,
			)
			.map((deployment) => ({
				createdAt: deployment.createdAt,
				errorMessage: deployment.errorMessage,
				finishedAt: deployment.finishedAt,
				id: deployment.id,
				rollback: deployment.rollbackOfDeploymentId !== null,
				startedAt: deployment.startedAt,
				status: deployment.status,
				trigger: deployment.trigger,
			})),
		revision,
	};
};

export const actions = {
	deployRevision: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const service = await ServiceDTO.get(params.serviceId);
		if (!service) {
			return fail(404, { error: "Service not found." });
		}
		const target = await RevisionService.findTarget(service, params.revisionId);
		if (target.error !== null) {
			return fail(target.status, { error: target.error });
		}
		const formData = await request.formData();
		const restoreConfig = formData.get("restoreConfig") === "on";
		const { deploymentId } = await RevisionService.enqueueRollback({
			restoreConfig,
			revision: target.revision,
			svc: service,
			userId: locals.user.id,
		});
		logger.info(
			`Revision deploy queued: service=${service.id} revision=${target.revision.id} deployment=${deploymentId} restoreConfig=${restoreConfig} user=${locals.user.id}`,
		);
		return { deploymentId, success: true };
	},
};
