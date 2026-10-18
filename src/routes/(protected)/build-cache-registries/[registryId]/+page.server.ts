import { error, fail } from "@sveltejs/kit";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("BuildCacheRegistries");

export const load = async ({ params, parent }) => {
	await parent();

	const registry = await BuildCacheRegistryDTO.get(params.registryId);
	if (!registry) {
		error(404, "Registry not found");
	}

	const services = await ServiceDTO.listByBuildCacheRegistry(registry.id);
	return {
		registry: {
			id: registry.id,
			name: registry.name,
			registryUrl: registry.registryUrl,
			username: registry.username,
		},
		services: services.map((svc) => ({
			currentStatus: svc.toJSON().currentStatus,
			id: svc.id,
			name: svc.name,
			slug: svc.slug,
		})),
	};
};

export const actions = {
	update: async ({ params, request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const registry = await BuildCacheRegistryDTO.get(params.registryId);
		if (!registry) {
			return fail(404, { error: "Registry not found." });
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim() ?? "";
		const registryUrl =
			(formData.get("registryUrl") as string | null)?.trim() ?? "";
		const username = (formData.get("username") as string | null)?.trim() ?? "";
		const password = (formData.get("password") as string | null)?.trim() ?? "";

		if (!(name && registryUrl && username)) {
			return fail(400, { error: "Name, URL and username are required." });
		}

		await registry.update({ name, password, registryUrl, username });
		logger.info(
			`Build cache registry updated: registry=${registry.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
