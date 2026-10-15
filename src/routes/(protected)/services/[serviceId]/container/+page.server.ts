import { fail, redirect } from "@sveltejs/kit";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { updateComputeSchema } from "#lib/server/validation/service.js";
import { errorPagesPublished } from "#lib/services/docker/error-pages.js";
import { ScaleToZeroService } from "#lib/services/scale-to-zero.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Services");

export const load = async () => {
	const settings = await InstanceSettingsDTO.get();
	return {
		errorPagesPublished: errorPagesPublished(),
		orchestrationMode: settings.orchestrationMode,
	};
};

export const actions = {
	updateCompute: async ({ request, params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updateComputeSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				errors: result.error.flatten().fieldErrors,
				values: Object.fromEntries(formData),
			});
		}
		const input = result.data;
		if (input.scaleToZeroEnabled && !input.scaleToZeroMinutes) {
			return fail(400, {
				errors: { scaleToZeroMinutes: ["Say how many idle minutes."] },
				values: Object.fromEntries(formData),
			});
		}

		const previousMinutes = svc.toJSON().scaleToZeroMinutes;
		await svc.update({
			cpuLimit: input.cpuLimit || null,
			memoryLimitMb: input.memoryLimitMb ?? null,
			replicas: input.replicas ?? 1,
			scaleToZeroMinutes: input.scaleToZeroEnabled
				? (input.scaleToZeroMinutes ?? null)
				: null,
		});
		await ScaleToZeroService.configured(svc, previousMinutes);

		logger.info(
			`Service compute settings updated: service=${svc.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
