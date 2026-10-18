import { error, fail } from "@sveltejs/kit";
import { ObjectStoreDTO } from "#lib/dto/object-store-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { ObjectStorageService } from "#lib/services/object-storage.service.js";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** A folder prefix from the URL or a form: no leading slash, one trailing slash, or empty for the bucket's root. */
function folderPrefix(raw: string): string {
	const trimmed = raw.replace(/^\/+/, "");
	return trimmed && !trimmed.endsWith("/") ? `${trimmed}/` : trimmed;
}

async function bucketClient(storeId: string) {
	const store = await ObjectStoreDTO.get(storeId);
	return store ? await ObjectStorageService.client(store) : null;
}

export const load = async ({ params, url }) => {
	const store = await ObjectStoreDTO.get(params.storeId);
	if (!store) {
		error(404, "That object store doesn't exist.");
	}
	const prefix = folderPrefix(url.searchParams.get("prefix") ?? "");
	const token = url.searchParams.get("token");
	const listing = await (await ObjectStorageService.client(store))
		.listObjects(params.bucket, prefix, token)
		.catch((cause: unknown) =>
			error(503, `The bucket can't be listed: ${reason(cause)}`),
		);
	return {
		bucket: params.bucket,
		listing,
		prefix,
		storeId: store.id,
		trail: prefix
			.split("/")
			.filter(Boolean)
			.map((name, index, parts) => ({
				name,
				prefix: `${parts.slice(0, index + 1).join("/")}/`,
			})),
	};
};

export const actions = {
	delete: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const client = await bucketClient(params.storeId);
		if (!client) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const key = String((await request.formData()).get("key") ?? "");
		if (!key) {
			return fail(400, { error: "Pick a file to delete." });
		}
		try {
			await client.deleteObject(params.bucket, key);
			return { success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	newFolder: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const client = await bucketClient(params.storeId);
		if (!client) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const formData = await request.formData();
		const name = String(formData.get("name") ?? "")
			.trim()
			.replace(/^\/+|\/+$/g, "");
		if (!name) {
			return fail(400, { error: "Name the folder." });
		}
		try {
			await client.putObject(
				params.bucket,
				`${folderPrefix(String(formData.get("prefix") ?? ""))}${name}/`,
				"",
			);
			return { success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},

	upload: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const client = await bucketClient(params.storeId);
		if (!client) {
			return fail(404, { error: "That object store doesn't exist." });
		}
		const formData = await request.formData();
		const prefix = folderPrefix(String(formData.get("prefix") ?? ""));
		const files = formData
			.getAll("files")
			.filter((file): file is File => file instanceof File && file.name !== "");
		if (files.length === 0) {
			return fail(400, { error: "Pick at least one file." });
		}
		try {
			for (const file of files) {
				// oxlint-disable-next-line no-await-in-loop -- one file in memory at a time
				const body = new Uint8Array(await file.arrayBuffer());
				// oxlint-disable-next-line no-await-in-loop -- one upload at a time, same reason
				await client.putObject(
					params.bucket,
					`${prefix}${file.name}`,
					body,
					file.type || "application/octet-stream",
				);
			}
			return { success: true, uploaded: files.length };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},
};
