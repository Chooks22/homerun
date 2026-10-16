import { fail, redirect } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { isPipelineProvider } from "#lib/pipelines/providers.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { PipelineService } from "#lib/services/pipeline.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Pipelines");

export const load = async ({ parent }) => {
	const { user } = await parent();
	const providers = await connectedGitProviders(user.id);
	return {
		providers: providers.filter((provider) =>
			isPipelineProvider(provider.kind),
		),
	};
};

export const actions = {
	watch: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const form = await request.formData();
		const providerId = String(form.get("providerId") ?? "").trim();
		const fullName = String(form.get("fullName") ?? "").trim();
		const defaultBranch = String(form.get("defaultBranch") ?? "").trim();
		if (!(providerId && fullName)) {
			return fail(400, { error: "Pick a repository." });
		}
		let repositoryId: string;
		try {
			const repo = await PipelineService.watch({
				defaultBranch: defaultBranch || null,
				fullName,
				providerId,
				userId: locals.user.id,
			});
			repositoryId = repo.id;
		} catch (err) {
			logger.warn(`Couldn't watch ${fullName}`, err);
			return fail(400, {
				error: err instanceof Error ? err.message : "Couldn't watch it.",
			});
		}
		redirect(
			303,
			resolve("/(protected)/pipelines/[repositoryId]", { repositoryId }),
		);
	},
};
