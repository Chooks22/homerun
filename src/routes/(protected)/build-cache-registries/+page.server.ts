import { fail } from "@sveltejs/kit";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("BuildCacheRegistries");

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{ sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const paged = await BuildCacheRegistryDTO.listPaged(query);
	return {
		filtered: query.active,
		page: paged.page,
		perPage: paged.perPage,
		registries: paged.items.map((r) => r.toJSON()),
		total: paged.total,
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const registryId = formData.get("registryId") as string | null;
		if (!registryId) {
			return fail(400, { error: "Missing registry id." });
		}

		const registry = await BuildCacheRegistryDTO.get(registryId);
		if (!registry) {
			return fail(404, { error: "Registry not found." });
		}

		await registry.delete();
		logger.info(
			`Build cache registry deleted: registry=${registryId} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
