import { error, fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { API_KEY_EXPIRY_OPTIONS } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

const logger = new Logger("ServiceAccounts");

export const actions = {
	create: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const name =
			String(formData.get("name") ?? "").trim() || "Service account key";
		const expiry = API_KEY_EXPIRY_OPTIONS.find(
			(option) => option.value === formData.get("expiry"),
		);
		if (!expiry) {
			return fail(400, { error: "Pick when the key expires." });
		}
		const created = await ServiceAccountService.createKey(
			params.accountId,
			name,
			expiry.days,
			locals.user.id,
		).catch((err: unknown) => {
			logger.warn("Couldn't create a service account key", err);
			return undefined;
		});
		if (created === undefined) {
			return fail(400, { error: "Couldn't create an API key." });
		}
		if (!created) {
			error(404, "That service account doesn't exist.");
		}
		return { key: created.key, success: true };
	},
};
