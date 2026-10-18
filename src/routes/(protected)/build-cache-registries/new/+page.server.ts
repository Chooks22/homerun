import { fail } from "@sveltejs/kit";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("BuildCacheRegistries");

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim() ?? "";
		const registryUrl =
			(formData.get("registryUrl") as string | null)?.trim() ?? "";
		const username = (formData.get("username") as string | null)?.trim() ?? "";
		const password = (formData.get("password") as string | null)?.trim() ?? "";

		if (!(name && registryUrl && username && password)) {
			return fail(400, { error: "Every field is required." });
		}

		const registry = await BuildCacheRegistryDTO.create({
			name,
			password,
			registryUrl,
			userId: locals.user.id,
			username,
		});

		logger.info(
			`Build cache registry added: registry=${registry.id} user=${locals.user.id}`,
		);

		return { success: true };
	},
};
