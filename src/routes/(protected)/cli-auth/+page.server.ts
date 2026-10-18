import { fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { CliAuthService } from "#lib/services/cli-auth.service.js";

const logger = new Logger("CliAuth");

export const load = ({ url }) => {
	const prefilledCode = url.searchParams.get("code") ?? "";
	return { prefilledCode };
};

export const actions = {
	approve: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const data = await request.formData();
		const code = (data.get("code") as string | null)?.trim() ?? "";
		if (!code) {
			return fail(400, { error: "Enter the code shown in your terminal." });
		}

		const ok = await CliAuthService.approve(code, locals.user.id);
		if (!ok) {
			return fail(404, {
				error:
					"That code wasn't found, or it's already expired. Run `homerun login` again.",
			});
		}

		logger.info(`CLI login approved by user=${locals.user.id}`);
		return { code, success: true };
	},

	deny: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const data = await request.formData();
		const code = (data.get("code") as string | null)?.trim() ?? "";
		CliAuthService.deny(code);
		return { code, denied: true };
	},
};
