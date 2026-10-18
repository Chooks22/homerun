import { fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import {
	API_KEY_EXPIRY_OPTIONS,
	intersectPermissions,
	permissionsFromForm,
	toApiKeyPermissions,
} from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { auth } from "#lib/services/auth.js";

const logger = new Logger("ApiKeys");

export const load = ({ locals }) => ({
	grantable: locals.permissions,
});

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim() || "API key";
		const expiry = API_KEY_EXPIRY_OPTIONS.find(
			(option) => option.value === formData.get("expiry"),
		);
		if (!expiry) {
			return fail(400, { error: "Pick when the key expires." });
		}
		const allPermissions = formData.get("allPermissions") === "on";
		const permissions = intersectPermissions(
			permissionsFromForm(formData),
			locals.permissions,
		);
		if (!allPermissions && Object.keys(permissions).length === 0) {
			return fail(400, {
				error: "Pick at least one permission, or allow all of them.",
			});
		}

		try {
			const created = await auth.api.createApiKey({
				body: {
					expiresIn: expiry.days ? expiry.days * 86_400 : null,
					name,
					permissions: allPermissions
						? undefined
						: toApiKeyPermissions(permissions),
					userId: locals.user.id,
				},
			});
			logger.info(
				`API key created: name=${name} expiry=${expiry.value} permissions=${allPermissions ? "all" : JSON.stringify(permissions)} user=${locals.user.id}`,
			);
			return { key: created.key, success: true };
		} catch (error) {
			logger.warn("Couldn't create API key", {
				error: error instanceof Error ? error.message : String(error),
			});
			return fail(400, { error: "Couldn't create an API key." });
		}
	},
};
