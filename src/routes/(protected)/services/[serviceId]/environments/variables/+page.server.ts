import { fail } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { HOST_ACCESS_MESSAGE, hostAccessChanged } from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	parseBuildEnvKeys,
	parseEnvVars,
	parseSecretEnvKeys,
	updateEnvFilesSchema,
} from "#lib/server/validation/service.js";

const logger = new Logger("Services");

export const load = ({ locals }) => ({
	hostAccess: can(locals.permissions, "system", "write"),
});

export const actions = {
	update: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const envVars = parseEnvVars(formData, svc.envVars);
		const secretEnvKeys = parseSecretEnvKeys(formData, envVars);
		let buildEnvKeys = svc.buildEnvKeys.filter((key) => key in envVars);
		if (svc.buildSource === "git") {
			try {
				buildEnvKeys = parseBuildEnvKeys(formData, envVars);
			} catch (error) {
				return fail(400, { error: (error as Error).message });
			}
		}

		await svc.update({ buildEnvKeys, envVars, secretEnvKeys });
		logger.info(`Env vars updated: service=${svc.id} user=${locals.user.id}`);
		return { success: true };
	},
	updateEnvFiles: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updateEnvFilesSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				envFilesError: result.error.issues[0]?.message ?? "Invalid path.",
			});
		}
		if (
			!can(locals.permissions, "system", "write") &&
			hostAccessChanged(svc.toJSON(), result.data)
		) {
			return fail(403, { envFilesError: HOST_ACCESS_MESSAGE });
		}
		await svc.update({ envFiles: result.data.envFiles });

		logger.info(
			`Env files updated: service=${svc.id} count=${result.data.envFiles.length} user=${locals.user.id}`,
		);
		return { envFilesSaved: true };
	},
};
