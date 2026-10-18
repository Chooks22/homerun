import { listOwnApiKeys, revokeApiKeyAction } from "#lib/server/api-keys.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

export const load = async ({ request }) => ({
	apiKeys: await listOwnApiKeys(request.headers),
});

export const actions = {
	revoke: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await revokeApiKeyAction(request, locals.user.id);
	},
};
