import { error } from "@sveltejs/kit";
import { RepositoryDTO } from "#lib/dto/repository-dto.js";

export const load = async ({ params, parent }) => {
	await parent();
	const repo = await RepositoryDTO.get(params.repositoryId);
	if (!repo) {
		error(404, "Repository not found");
	}
	return {
		crumb: { id: repo.id, name: repo.fullName },
		linkedServices: await repo.linkedServices(),
		repository: repo.toJSON(),
	};
};
