import { redirect } from "@sveltejs/kit";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { AdminService } from "#lib/services/admin.service.js";
import { resolve } from "$app/paths";

export const load = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, resolve(""));
	}
	if (await AdminService.hasAnyUser()) {
		redirectToSignIn();
	}
};
