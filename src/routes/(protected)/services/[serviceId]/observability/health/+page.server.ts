import { fail } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { updateHealthSchema } from "#lib/server/validation/service.js";
import { HEALTHCHECK_DEFAULTS } from "#lib/services/docker/healthcheck.js";
import { DockerService } from "#lib/services/docker.service.js";

const logger = new Logger("Services");

export const load = async ({ parent }) => {
	const { service } = await parent();
	return {
		applied: service.containerId
			? await DockerService.containerHealthcheck(service.containerId)
			: null,
		defaults: HEALTHCHECK_DEFAULTS,
		swarm: !!service.swarmServiceId,
	};
};

export const actions = {
	updateHealth: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updateHealthSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				errors: result.error.flatten().fieldErrors,
				values: Object.fromEntries(formData),
			});
		}
		const input = result.data;

		await svc.update({
			healthcheckCommand: input.healthcheckCommand || null,
			healthcheckDisabled: input.healthcheckDisabled,
			healthcheckIntervalSeconds: input.healthcheckIntervalSeconds ?? null,
			healthcheckRetries: input.healthcheckRetries ?? null,
			healthcheckStartPeriodSeconds:
				input.healthcheckStartPeriodSeconds ?? null,
			healthcheckTimeoutSeconds: input.healthcheckTimeoutSeconds ?? null,
		});

		logger.info(
			`Service healthcheck updated: service=${svc.id} disabled=${input.healthcheckDisabled} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
