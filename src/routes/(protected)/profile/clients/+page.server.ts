import { fail } from "@sveltejs/kit";
import { OauthGrantDTO } from "#lib/dto/oauth-grant-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("ApiKeys");

export const load = async ({ parent }) => {
	const { user } = await parent();
	return { authorizedApps: await OauthGrantDTO.listForUser(user.id) };
};

export const actions = {
	revokeApp: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const clientId = (formData.get("clientId") as string | null)?.trim();
		if (!clientId) {
			return fail(400, { error: "Missing app id." });
		}
		await OauthGrantDTO.revokeForUser(locals.user.id, clientId);
		logger.info(
			`App access revoked: client=${clientId} user=${locals.user.id}`,
		);
		return { appRevoked: true };
	},
};
