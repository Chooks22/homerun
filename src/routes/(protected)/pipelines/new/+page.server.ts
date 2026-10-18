import { fail, redirect } from "@sveltejs/kit";
import { z } from "zod";
import { RepositoryDTO } from "#lib/dto/repository-dto.js";
import { Logger } from "#lib/logger.js";
import { isPipelineProvider } from "#lib/pipelines/providers.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { PipelineService } from "#lib/services/pipeline.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Pipelines");

const pickedRepo = z.object({
	defaultBranch: z.string().nullable().catch(null),
	fullName: z.string().min(1),
});

export const load = async ({ parent }) => {
	const { user } = await parent();
	const [providers, watched] = await Promise.all([
		connectedGitProviders(user.id),
		RepositoryDTO.list(),
	]);
	return {
		providers: providers.filter((provider) =>
			isPipelineProvider(provider.kind),
		),
		watched: watched.map((repo) => `${repo.providerId}:${repo.fullName}`),
	};
};

export const actions = {
	watch: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const form = await request.formData();
		const providerId = String(form.get("providerId") ?? "").trim();
		const picked = form
			.getAll("repos")
			.map((raw) => {
				try {
					return pickedRepo.parse(JSON.parse(String(raw)));
				} catch {
					return null;
				}
			})
			.filter((repo) => repo !== null);
		if (!(providerId && picked.length)) {
			return fail(400, { error: "Pick at least one repository." });
		}
		const failed: string[] = [];
		const watched: string[] = [];
		for (const repo of picked) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- one repository at a time keeps the provider calls and job inserts in order
				const created = await PipelineService.watch({
					defaultBranch: repo.defaultBranch,
					fullName: repo.fullName,
					providerId,
					userId: locals.user.id,
				});
				watched.push(created.id);
			} catch (err) {
				logger.warn(`Couldn't watch ${repo.fullName}`, err);
				failed.push(
					`${repo.fullName}: ${err instanceof Error ? err.message : "couldn't watch it"}`,
				);
			}
		}
		if (failed.length && !watched.length) {
			return fail(400, { error: failed.join(" ") });
		}
		redirect(
			303,
			watched.length === 1
				? resolve("/(protected)/pipelines/[repositoryId]", {
						repositoryId: watched[0],
					})
				: resolve("pipelines"),
		);
	},
};
