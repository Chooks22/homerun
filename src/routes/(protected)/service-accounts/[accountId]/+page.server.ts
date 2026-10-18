import { fail } from "@sveltejs/kit";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const load = async ({ params }) => ({
	keys: await ServiceAccountService.listKeys(params.accountId),
});

export const actions = {
	revoke: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const keyId = String((await request.formData()).get("keyId") ?? "");
		const revoked = await ServiceAccountService.revokeKey(
			params.accountId,
			keyId,
			locals.user.id,
		);
		if (!revoked) {
			return fail(404, { error: "That key doesn't exist." });
		}
		return { revoked: true };
	},
};
