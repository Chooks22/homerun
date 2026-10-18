import { fail } from "@sveltejs/kit";
import { IacProjectDTO } from "#lib/dto/iac-project-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { IacStateService } from "#lib/services/iac-state.service.js";

export const actions = {
	delete: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const project = await IacProjectDTO.get(params.projectId);
		if (!project) {
			return fail(404, { error: "That IaC project doesn't exist." });
		}
		await project.delete();
		return { success: true };
	},

	update: async ({ params, locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const project = await IacProjectDTO.get(params.projectId);
		if (!project) {
			return fail(404, { error: "That IaC project doesn't exist." });
		}
		const formData = await request.formData();
		try {
			await IacStateService.updateProject(project, {
				name: String(formData.get("name") ?? ""),
				scope: String(formData.get("scope") ?? ""),
				tool: String(formData.get("tool") ?? ""),
			});
			return { success: true };
		} catch (cause) {
			return fail(400, {
				error: cause instanceof Error ? cause.message : String(cause),
			});
		}
	},
};
