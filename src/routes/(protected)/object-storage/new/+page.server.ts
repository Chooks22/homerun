import { fail } from "@sveltejs/kit";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";

export const actions = {
	createBucket: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const store = await ObjectStoreDTO.get(
			String(formData.get("storeId") ?? ""),
		);
		if (!store) {
			return fail(400, { error: "Pick a store." });
		}
		const bucket = String(formData.get("bucket") ?? "").trim();
		try {
			await ObjectStorageService.createBucket(store, bucket);
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (formData.get("public") === "on") {
			await ObjectStorageService.setPublic(store, bucket, true);
		}
		return { bucket, storeId: store.id, success: true };
	},
};
