import { fail } from "@sveltejs/kit";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { HOST_ACCESS_MESSAGE, hostAccessChanged } from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { updateRuntimeSchema } from "#lib/server/validation/service.js";

const logger = new Logger("Services");

export const load = async ({ locals }) => {
	const settings = await InstanceSettingsDTO.get();
	return {
		hostAccess: can(locals.permissions, "system", "write"),
		orchestrationMode: settings.orchestrationMode,
	};
};

export const actions = {
	updateRuntime: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updateRuntimeSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				errors: result.error.flatten().fieldErrors,
				values: Object.fromEntries(formData),
			});
		}

		if (
			!can(locals.permissions, "system", "write") &&
			hostAccessChanged(svc.toJSON(), result.data)
		) {
			return fail(403, {
				error: HOST_ACCESS_MESSAGE,
				values: Object.fromEntries(formData),
			});
		}

		await svc.update(result.data);

		logger.info(
			`Service runtime settings updated: service=${svc.id} privileged=${result.data.privileged} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
