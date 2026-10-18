import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { enqueueCoreServiceJob } from "#lib/services/core-service-queue.js";
import { RegistryService } from "#lib/services/registry.service.js";

export const load = () => ({
	suggestedHost: config.baseDomain ? `registry.${config.baseDomain}` : "",
});

export const actions = {
	setAuth: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const enabled = (await request.formData()).get("enabled") === "on";
		const problem = await RegistryService.authProblem(enabled);
		if (problem) {
			return fail(400, { error: problem });
		}
		const job = await enqueueCoreServiceJob(
			{ action: "setRegistryAuth", enabled },
			locals.user.id,
		);
		return { jobId: job.id, success: true };
	},

	setPublicHost: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const host = String((await request.formData()).get("publicHost") ?? "");
		const problem = await RegistryService.publicHostProblem(host);
		if (problem) {
			return fail(400, { error: problem });
		}
		const job = await enqueueCoreServiceJob(
			{ action: "publishRegistry", host },
			locals.user.id,
		);
		return { jobId: job.id, success: true };
	},
};
