import { error, fail, redirect } from "@sveltejs/kit";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	GitProviderConfigError,
	GitProviderConfigService,
	type GitProviderSettings,
} from "#lib/services/git-provider-config.service.js";
import { resolve } from "$app/paths";

const SELF_HOSTABLE = new Set(["gitlab", "gitea"]);

export const load = ({ locals }) => {
	if (!can(locals.permissions, "git-providers", "write")) {
		error(403, "You don't have permission to change git providers.");
	}
	return {};
};

export const actions = {
	delete: async ({ locals, params }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!(await GitProviderConfigService.get(params.providerId))) {
			return fail(404, { error: "That provider doesn't exist." });
		}
		await GitProviderConfigService.remove(params.providerId, locals.user.id);
		redirect(303, resolve("git-providers"));
	},

	setEnabled: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const enabled = (await request.formData()).get("enabled") === "true";
		try {
			await GitProviderConfigService.update(params.providerId, { enabled });
		} catch (err) {
			if (err instanceof GitProviderConfigError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { enabled };
	},

	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const provider = await GitProviderConfigService.get(params.providerId);
		if (!provider) {
			return fail(404, { error: "That provider doesn't exist." });
		}
		const formData = await request.formData();
		const input: GitProviderSettings = {
			name: String(formData.get("name") ?? ""),
		};
		if (provider.kind !== "github") {
			input.clientId = String(formData.get("clientId") ?? "");
			input.clientSecret = String(formData.get("clientSecret") ?? "");
		}
		if (SELF_HOSTABLE.has(provider.kind)) {
			input.baseUrl = String(formData.get("baseUrl") ?? "");
		}
		try {
			await GitProviderConfigService.update(params.providerId, input);
		} catch (err) {
			if (err instanceof GitProviderConfigError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { updated: true };
	},
};
