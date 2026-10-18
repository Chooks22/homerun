import { error } from "@sveltejs/kit";
import { listOwnApiKeys, updateApiKeyAction } from "#lib/server/api-keys.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

export const load = async ({ locals, params, request }) => {
	const key = (await listOwnApiKeys(request.headers)).find(
		(entry) => entry.id === params.keyId,
	);
	if (!key) {
		error(404, "That API key doesn't exist.");
	}
	return { apiKey: key, grantable: locals.permissions };
};

export const actions = {
	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await updateApiKeyAction(
			params.keyId,
			locals.user.id,
			locals.permissions,
			await request.formData(),
		);
	},
};
