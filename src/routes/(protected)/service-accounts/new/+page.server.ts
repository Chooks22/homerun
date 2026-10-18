import { fail, redirect } from "@sveltejs/kit";
import { intersectPermissions, permissionsFromForm } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { resolve } from "$app/paths";

export const load = ({ locals }) => ({
	grantable: locals.permissions,
});

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const name = String(formData.get("name") ?? "").trim();
		if (!name) {
			return fail(400, { error: "Give the service account a name." });
		}
		const created = await ServiceAccountService.create(
			name,
			intersectPermissions(permissionsFromForm(formData), locals.permissions),
			locals.user.id,
		);
		redirect(
			303,
			resolve("/(protected)/service-accounts/[accountId]", {
				accountId: created.id,
			}),
		);
	},
};
