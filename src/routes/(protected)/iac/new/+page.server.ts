import { fail } from "@sveltejs/kit";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { IacInventoryService } from "#lib/services/iac-inventory.service.js";
import { IacStateService } from "#lib/services/iac-state.service.js";

export const load = async () => {
	const [stores, settings, scopes] = await Promise.all([
		ObjectStoreDTO.list(),
		InstanceSettingsDTO.get(),
		IacInventoryService.scopeOptions(),
	]);
	const builtinEnabled = settings.toJSON().garageEnabled === true;
	return {
		scopes,
		stores: stores
			.filter((store) => store.kind !== "garage" || builtinEnabled)
			.map((store) => store.summary()),
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		try {
			const project = await IacStateService.createProject({
				bucket: String(formData.get("bucket") ?? "").trim(),
				name: String(formData.get("name") ?? ""),
				prefix: String(formData.get("prefix") ?? ""),
				scope: String(formData.get("scope") ?? ""),
				storeId: String(formData.get("storeId") ?? ""),
				tool: String(formData.get("tool") ?? ""),
				userId: locals.user.id,
			});
			return { projectId: project.id, success: true };
		} catch (cause) {
			return fail(400, {
				error: cause instanceof Error ? cause.message : String(cause),
			});
		}
	},
};
