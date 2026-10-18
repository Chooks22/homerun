import { error, fail, redirect } from "@sveltejs/kit";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { RegistryService } from "#lib/services/registry.service.js";
import { resolve } from "$app/paths";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const load = async ({ params }) => {
	const repository = await RegistryService.repository(params.repository).catch(
		(cause: unknown) =>
			error(503, `The registry isn't answering: ${reason(cause)}`),
	);
	if (!repository) {
		redirect(307, resolve("/(protected)/registry"));
	}
	return { repository };
};

export const actions = {
	deleteRepository: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		try {
			const deleted = await RegistryService.deleteRepository(params.repository);
			return { deleted, success: true };
		} catch (cause) {
			return fail(500, { error: reason(cause) });
		}
	},

	deleteTag: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const tag = String((await request.formData()).get("tag") ?? "");
		if (!tag) {
			return fail(400, { error: "Which tag?" });
		}
		try {
			const deleted = await RegistryService.deleteTag(params.repository, tag);
			return deleted
				? { success: true }
				: fail(404, { error: `${params.repository}:${tag} was already gone.` });
		} catch (cause) {
			return fail(500, { error: reason(cause) });
		}
	},
};
