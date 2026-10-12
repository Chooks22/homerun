import { fail, redirect } from "@sveltejs/kit";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";
import { resolve } from "$app/paths";

export const actions = {
	createBucket: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
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
