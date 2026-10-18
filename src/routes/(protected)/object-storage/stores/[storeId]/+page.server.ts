import { error, fail } from "@sveltejs/kit";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { parseObjectStoreForm } from "#lib/server/validation/object-store.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const load = async ({ params }) => {
	const store = await ObjectStoreDTO.get(params.storeId);
	if (!store || store.kind === "garage") {
		error(404, "That object store doesn't exist.");
	}
	return { store: store.summary() };
};

export const actions = {
	delete: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store || store.kind === "garage") {
			return fail(404, { error: "That object store doesn't exist." });
		}
		await store.delete();
		return { success: true };
	},

	test: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		try {
			const buckets = (
				await (await ObjectStorageService.client(store)).listBuckets()
			).length;
			return { buckets, success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	update: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store || store.kind === "garage") {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const { error: problem, values } = parseObjectStoreForm(
			await request.formData(),
			false,
		);
		if (problem) {
			return fail(400, { error: problem });
		}
		try {
			await ObjectStorageService.updateStore(store, values);
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
		return { success: true };
	},
};
