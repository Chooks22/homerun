import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import { RegistryService } from "#lib/services/registry.service.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	try {
		const page = await RegistryService.catalogPage(parseApiListQuery(url));
		return jsonPage(page.items, page);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return apiError(`The registry isn't answering: ${reason}`, 503);
	}
};
