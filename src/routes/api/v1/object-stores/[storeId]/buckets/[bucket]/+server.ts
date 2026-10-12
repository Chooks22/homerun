import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { PublicBucketDTO } from "#lib/dto/public-bucket-dto.js";
import { bucketApiJson } from "#lib/server/api-json.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { updateBucketApiBody } from "#lib/server/validation/api-resources.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The store when the bucket exists on it, else the 404 or 502 response. */
async function bucketStore(storeId: string, bucket: string) {
	const store = await ObjectStoreDTO.get(storeId);
	if (!store) {
		return apiError("Not found", 404);
	}
	try {
		return (await ObjectStorageService.bucketNames(store)).includes(bucket)
			? store
			: apiError("Not found", 404);
	} catch (cause) {
		return apiError(reason(cause), 502);
	}
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const store = await bucketStore(params.storeId, params.bucket);
	if (store instanceof Response) {
		return store;
	}
	try {
		const [detail, isPublic] = await Promise.all([
			ObjectStorageService.bucket(store, params.bucket),
			PublicBucketDTO.isPublic(store.id, params.bucket),
		]);
		return Response.json(
			bucketApiJson(
				store.id,
				params.bucket,
				detail?.expirationDays ?? null,
				isPublic,
			),
		);
	} catch (cause) {
		return apiError(reason(cause), 502);
	}
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const store = await bucketStore(params.storeId, params.bucket);
	if (store instanceof Response) {
		return store;
	}
	const body = await readApiBody(request, updateBucketApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		if (body.data.expirationDays !== undefined) {
			await ObjectStorageService.setExpiration(
				store,
				params.bucket,
				body.data.expirationDays,
			);
		}
		if (body.data.public !== undefined) {
			await ObjectStorageService.setPublic(
				store,
				params.bucket,
				body.data.public,
			);
		}
		const [detail, isPublic] = await Promise.all([
			ObjectStorageService.bucket(store, params.bucket),
			PublicBucketDTO.isPublic(store.id, params.bucket),
		]);
		return Response.json(
			bucketApiJson(
				store.id,
				params.bucket,
				detail?.expirationDays ?? null,
				isPublic,
			),
		);
	} catch (cause) {
		return apiError(reason(cause));
	}
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const store = await bucketStore(params.storeId, params.bucket);
	if (store instanceof Response) {
		return store;
	}
	try {
		await ObjectStorageService.deleteBucket(store, params.bucket);
	} catch (cause) {
		return apiError(reason(cause), 409);
	}
	return new Response(null, { status: 204 });
};
