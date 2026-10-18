import { error, fail, redirect } from "@sveltejs/kit";
import { RepositoryDTO } from "#lib/dto/repository-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { formatRates } from "#lib/pipelines/cost.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { PipelineService } from "#lib/services/pipeline.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Pipelines");

export const load = async ({ parent }) => {
	const { repository } = await parent();
	const repo = await RepositoryDTO.get(repository.id);
	if (!repo) {
		error(404, "Repository not found");
	}
	const services = (await ServiceDTO.list())
		.map((svc) => svc.toJSON())
		.filter((row) => !row.previewParentId)
		.map((row) => ({
			id: row.id,
			linkedElsewhere: !!row.repositoryId && row.repositoryId !== repo.id,
			linkedHere: row.repositoryId === repo.id,
			name: row.name,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		defaultRates: formatRates(PipelineService.rates(repo)),
		services,
	};
};

export const actions = {
	save: async ({ params, request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const repo = await RepositoryDTO.get(params.repositoryId);
		if (!repo) {
			return fail(404, { error: "Repository not found." });
		}
		const form = await request.formData();
		try {
			await PipelineService.saveSettings(repo, {
				enabled: form.get("pipelinesEnabled") === "on",
				rates: String(form.get("rates") ?? ""),
				serviceIds: form.getAll("serviceIds").map(String),
			});
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : "Couldn't save.",
			});
		}
		return { saved: true };
	},
	delete: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const repo = await RepositoryDTO.get(params.repositoryId);
		if (!repo) {
			return fail(404, { error: "Repository not found." });
		}
		await repo.delete();
		logger.info(
			`Stopped watching repository=${repo.id} ${repo.fullName} user=${locals.user.id}`,
		);
		redirect(303, resolve("pipelines"));
	},
};
