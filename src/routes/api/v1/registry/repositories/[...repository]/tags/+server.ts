import { apiCaller, apiError } from "#lib/server/api-route.js";
import { isValidRepository } from "#lib/services/docker/mirror-registry.js";
import { RegistryService } from "#lib/services/registry.service.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	if (!isValidRepository(params.repository)) {
		return apiError("Not a valid repository name");
	}
	try {
		const repository = await RegistryService.repository(params.repository);
		return repository
			? Response.json(repository.tags)
			: apiError("Not found", 404);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return apiError(`The registry isn't answering: ${reason}`, 503);
	}
};
