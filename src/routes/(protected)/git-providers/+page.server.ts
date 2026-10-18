import { fail } from "@sveltejs/kit";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { githubAppRegistration } from "#lib/github-app.js";
import { can } from "#lib/permissions.js";
import { browserOrigin } from "#lib/server/canonical-origin.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { GitProviderService } from "#lib/services/git-provider.service.js";
import {
	GitProviderConfigError,
	GitProviderConfigService,
} from "#lib/services/git-provider-config.service.js";

const GITHUB_ORG_PATTERN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

export const load = async ({ parent, locals }) => {
	const { user } = await parent();
	const settings = await InstanceSettingsDTO.get();
	const connections = await GitConnectionDTO.listForUser(user.id);
	const connectedProviderIds = new Set(connections.map((c) => c.providerId));

	return {
		canWrite: can(locals.permissions, "git-providers", "write"),
		connectedProviderIds: [...connectedProviderIds],
		// clientSecretEnc never leaves the server : the form only ever shows
		// "configured" vs not, same convention as registryPassword/smtpPassword.
		providers: settings.gitProviders.map((p) => ({
			baseUrl: p.baseUrl,
			enabled: p.enabled,
			id: p.id,
			kind: p.kind,
			name: p.name,
		})),
	};
};

export const actions = {
	createGithubApp: async ({ request, locals, url }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim() ?? "";
		const org = (formData.get("org") as string | null)?.trim() || null;
		if (!name) {
			return fail(400, { error: "Name is required." });
		}
		if (name.length > 34) {
			return fail(400, {
				error: "GitHub App names are at most 34 characters.",
			});
		}
		if (org && !GITHUB_ORG_PATTERN.test(org)) {
			return fail(400, { error: "That isn't a GitHub organization name." });
		}

		const providerId = crypto.randomUUID();
		return {
			githubApp: githubAppRegistration({
				name,
				org,
				origin: browserOrigin(request, url),
				providerId,
				state: GitProviderService.createState(providerId, locals.user.id),
			}),
		};
	},

	addProvider: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		try {
			await GitProviderConfigService.add(
				{
					baseUrl: formData.get("baseUrl") as string | null,
					clientId: (formData.get("clientId") as string | null) ?? "",
					clientSecret: (formData.get("clientSecret") as string | null) ?? "",
					kind: formData.get("kind") as string | null,
					name: (formData.get("name") as string | null) ?? "",
				},
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof GitProviderConfigError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { added: true };
	},

	deleteProvider: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const id = formData.get("id") as string | null;
		if (!id) {
			return fail(400, { error: "Missing provider id." });
		}

		await GitProviderConfigService.remove(id, locals.user.id);
		return { deleted: true };
	},
};
