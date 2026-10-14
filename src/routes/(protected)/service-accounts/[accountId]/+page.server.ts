import { fail, redirect } from "@sveltejs/kit";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { resolve } from "$app/paths";

export const load = async ({ params }) => ({
	keys: await ServiceAccountService.listKeys(params.accountId),
});

export const actions = {
	revoke: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
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
