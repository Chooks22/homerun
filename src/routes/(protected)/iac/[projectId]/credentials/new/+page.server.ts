import { createIacApiKeyAction } from "#lib/server/iac-api-key.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

export const actions = {
	createApiKey: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await createIacApiKeyAction(
			locals.user.id,
			locals.permissions,
			await request.formData(),
		);
	},
};
