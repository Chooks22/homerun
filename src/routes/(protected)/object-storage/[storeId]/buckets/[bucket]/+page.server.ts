import { error, fail } from "@sveltejs/kit";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { PublicBucketDTO } from "#lib/dto/public-bucket-dto.js";
import { MAX_EXPIRATION_DAYS } from "#lib/object-storage.js";
import {
	createBucketKeyAction,
	revokeBucketKeyAction,
} from "#lib/server/bucket-key-actions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const load = async ({ params, url }) => {
	const store = await ObjectStoreDTO.get(params.storeId);
	if (!store) {
		error(404, "That object store doesn't exist.");
	}
	const detail = await ObjectStorageService.bucket(store, params.bucket).catch(
		(cause: unknown) =>
			error(503, `The bucket can't be read: ${reason(cause)}`),
	);
	if (!detail) {
		error(404, `${params.bucket} doesn't exist on ${store.name}.`);
	}
	return {
		bucket: params.bucket,
		detail,
		isPublic: await PublicBucketDTO.isPublic(store.id, params.bucket),
		publicUrl: await ObjectStorageService.publicUrl(
			store,
			params.bucket,
			url.origin,
		),
		store: store.summary(),
		usage: ObjectStorageService.usage(store, params.bucket).catch(() => null),
	};
};

export const actions = {
	setPublic: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		await ObjectStorageService.setPublic(
			store,
			params.bucket,
			(await request.formData()).get("public") === "on",
		);
		return { success: true };
	},

	createKey: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		return await createBucketKeyAction(
			store,
			params.bucket,
			await request.formData(),
		);
	},

	deleteBucket: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const empty = (await request.formData()).get("empty") === "on";
		try {
			await ObjectStorageService.deleteBucket(store, params.bucket, empty);
			return { success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	emptyBucket: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		try {
			return {
				emptied: await ObjectStorageService.emptyBucket(store, params.bucket),
				success: true,
			};
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	revokeKey: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		return await revokeBucketKeyAction(store, await request.formData());
	},

	setExpiration: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const raw = String((await request.formData()).get("days") ?? "").trim();
		const days = raw ? Number(raw) : null;
		if (
			days !== null &&
			!(Number.isInteger(days) && days >= 1 && days <= MAX_EXPIRATION_DAYS)
		) {
			return fail(400, {
				error: `Days is a whole number from 1 to ${MAX_EXPIRATION_DAYS}, or empty to keep objects forever.`,
			});
		}
		try {
			await ObjectStorageService.setExpiration(store, params.bucket, days);
			return { success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	useAsBackupDestination: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const store = await ObjectStoreDTO.get(params.storeId);
		if (!store) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		try {
			const destination = await ObjectStorageService.useAsBackupDestination(
				store,
				params.bucket,
				locals.user.id,
			);
			return { destinationId: destination.id, success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},
};
