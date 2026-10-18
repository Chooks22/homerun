import { fail } from "@sveltejs/kit";
import { OauthClientDTO } from "#lib/dto/oauth-client-dto.js";
import { OauthGrantDTO } from "#lib/dto/oauth-grant-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("OidcProvider");

export const load = async ({ parent }) => {
	const { app } = await parent();
	return { grantees: await OauthGrantDTO.listForClient(app.clientId) };
};

export const actions = {
	revoke: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const app = await OauthClientDTO.get(params.appId);
		if (!app) {
			return fail(404, { error: "That app isn't registered." });
		}
		const userId = String((await request.formData()).get("userId") ?? "");
		const targets = userId
			? [userId]
			: (await OauthGrantDTO.listForClient(app.clientId)).map(
					(grantee) => grantee.userId,
				);
		await Promise.all(
			targets.map((target) =>
				OauthGrantDTO.revokeForUser(target, app.clientId),
			),
		);
		logger.info(
			`OAuth app access revoked: client=${app.clientId} users=${targets.length} user=${locals.user.id}`,
		);
		return { revoked: targets.length };
	},
};
