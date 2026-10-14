import { fail, redirect } from "@sveltejs/kit";
import { intersectPermissions, permissionsFromForm } from "#lib/permissions.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { resolve } from "$app/paths";

export const load = ({ locals }) => ({
	grantable: locals.permissions,
});

export const actions = {
	delete: async ({ locals, params }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		if (
			!(await ServiceAccountService.delete(params.accountId, locals.user.id))
		) {
			return fail(404, { error: "That service account doesn't exist." });
		}
		redirect(303, resolve("service-accounts"));
	},

	setDisabled: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const disabled = (await request.formData()).get("disabled") === "true";
		const updated = await ServiceAccountService.update(
			params.accountId,
			{ disabled },
			locals.user.id,
		);
		if (!updated) {
			return fail(404, { error: "That service account doesn't exist." });
		}
		return { disabled };
	},

	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const name = String(formData.get("name") ?? "").trim();
		if (!name) {
			return fail(400, { error: "Give the service account a name." });
		}
		const updated = await ServiceAccountService.update(
			params.accountId,
			{
				name,
				permissions: intersectPermissions(
					permissionsFromForm(formData),
					locals.permissions,
				),
			},
			locals.user.id,
		);
		if (!updated) {
			return fail(404, { error: "That service account doesn't exist." });
		}
		return { updated: true };
	},
};
