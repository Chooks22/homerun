import { createHash } from "node:crypto";
import {
	lifecycleExpirationDays,
	lifecycleXml,
	USAGE_OBJECT_CAP,
} from "#lib/object-storage.js";
import { expectS3Ok, type S3Credentials, s3Fetch } from "./signer.ts";

export interface BucketSummary {
	createdAt: string | null;
	name: string;
}

export interface BucketObject {
	key: string;
	lastModified: string | null;
	size: number;
}

export interface ObjectListing {
	folders: string[];
	nextToken: string | null;
	objects: BucketObject[];
}

export interface BucketUsage {
	bytes: number;
	capped: boolean;
	objects: number;
}

const PAGE_SIZE = 1000;

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&apos;": "'",
	"&gt;": ">",
	"&lt;": "<",
	"&quot;": '"',
};

function tagValue(xml: string, tag: string): string | null {
	const raw = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
	return raw === undefined
		? null
		: raw.replace(/&(amp|apos|gt|lt|quot);/g, (entity) => XML_ENTITIES[entity]);
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function blocks(xml: string, tag: string): string[] {
	return [
		...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
	].map((match) => match[1]);
}

/**
 * Bucket-level S3 calls against one store (AWS, Garage, MinIO, Hetzner, any
 * S3-compatible endpoint), signed with SigV4 and parsed from the XML by hand,
 * so no SDK is needed.
 */
export class ObjectStoreClient {
	readonly #credentials: S3Credentials;
	readonly #fetch: typeof fetch;

	constructor(credentials: S3Credentials, fetcher: typeof fetch = fetch) {
		this.#credentials = credentials;
		this.#fetch = fetcher;
	}

	/**
	 * Every bucket the credentials can see, by name.
	 *
	 * @throws When the store refuses or can't be reached.
	 */
	async listBuckets(): Promise<BucketSummary[]> {
		const response = await s3Fetch(
			this.#credentials,
			{ method: "GET", path: "/" },
			this.#fetch,
		);
		await expectS3Ok(response, "ListBuckets");
		return blocks(await response.text(), "Bucket")
			.map((bucket) => ({
				createdAt: tagValue(bucket, "CreationDate"),
				name: tagValue(bucket, "Name") ?? "",
			}))
			.filter((bucket) => bucket.name)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Creates a bucket, in the store's region when that isn't AWS's default
	 * one, which is the only region that refuses an explicit constraint.
	 *
	 * @throws With the store's own error, e.g. a name already taken.
	 */
	async createBucket(name: string): Promise<void> {
		const region = this.#credentials.region;
		const body =
			region && region !== "us-east-1"
				? `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`
				: undefined;
		await expectS3Ok(
			await s3Fetch(
				this.#credentials,
				{ body, method: "PUT", path: `/${name}` },
				this.#fetch,
			),
			"CreateBucket",
		);
	}

	/**
	 * Deletes an empty bucket.
	 *
	 * @throws With a plain message when the bucket still holds objects, the
	 *   store's own error otherwise.
	 */
	async deleteBucket(name: string): Promise<void> {
		const response = await s3Fetch(
			this.#credentials,
			{ method: "DELETE", path: `/${name}` },
			this.#fetch,
		);
		if (response.status === 409) {
			throw new Error(
				`${name} still holds objects. Empty it first, then delete it.`,
			);
		}
		await expectS3Ok(response, "DeleteBucket");
	}

	/**
	 * Deletes every object in a bucket, a page of up to 1000 keys per
	 * DeleteObjects call, returning how many were deleted.
	 *
	 * @throws When a page can't be listed, or the store refuses to delete a key.
	 */
	async emptyBucket(name: string): Promise<number> {
		let deleted = 0;
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- each page is listed after the previous one is gone
			const response = await s3Fetch(
				this.#credentials,
				{
					method: "GET",
					path: `/${name}`,
					query: { "list-type": "2", "max-keys": String(PAGE_SIZE) },
				},
				this.#fetch,
			);
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			await expectS3Ok(response, "ListObjectsV2");
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			const keys = blocks(await response.text(), "Contents")
				.map((entry) => tagValue(entry, "Key"))
				.filter((key): key is string => Boolean(key));
			if (keys.length === 0) {
				return deleted;
			}
			const body = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${keys
				.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`)
				.join("")}</Delete>`;
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			const result = await s3Fetch(
				this.#credentials,
				{
					body,
					headers: {
						"content-md5": createHash("md5").update(body).digest("base64"),
						"content-type": "application/xml",
					},
					method: "POST",
					path: `/${name}`,
					query: { delete: "" },
				},
				this.#fetch,
			);
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			await expectS3Ok(result, "DeleteObjects");
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			const failed = blocks(await result.text(), "Error");
			if (failed.length > 0) {
				const first = failed[0];
				throw new Error(
					`Couldn't delete ${tagValue(first, "Key") ?? "an object"}: ${tagValue(first, "Message") ?? tagValue(first, "Code") ?? "refused"}`,
				);
			}
			deleted += keys.length;
		}
	}

	/**
	 * How many objects a bucket holds and their total size, listing at most
	 * `cap` objects so a huge bucket can't stall the page: `capped` says the
	 * real numbers are higher.
	 *
	 * @throws When the bucket can't be listed.
	 */
	async usage(name: string, cap = USAGE_OBJECT_CAP): Promise<BucketUsage> {
		let objects = 0;
		let bytes = 0;
		let token: string | null = null;
		do {
			const query: Record<string, string> = {
				"list-type": "2",
				"max-keys": String(PAGE_SIZE),
			};
			if (token) {
				query["continuation-token"] = token;
			}
			// oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's continuation token
			const response = await s3Fetch(
				this.#credentials,
				{ method: "GET", path: `/${name}`, query },
				this.#fetch,
			);
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			await expectS3Ok(response, "ListObjectsV2");
			// oxlint-disable-next-line no-await-in-loop -- same page as above
			const xml = await response.text();
			for (const entry of blocks(xml, "Contents")) {
				objects += 1;
				bytes += Number.parseInt(tagValue(entry, "Size") ?? "0", 10);
			}
			token =
				tagValue(xml, "IsTruncated") === "true"
					? tagValue(xml, "NextContinuationToken")
					: null;
		} while (token && objects < cap);
		return { bytes, capped: token !== null, objects };
	}

	/**
	 * The days after which the bucket expires objects, or null when it has
	 * no expiring lifecycle rule.
	 *
	 * @throws When the store refuses the request for another reason.
	 */
	async expirationDays(name: string): Promise<number | null> {
		const response = await s3Fetch(
			this.#credentials,
			{ method: "GET", path: `/${name}`, query: { lifecycle: "" } },
			this.#fetch,
		);
		if (response.status === 404) {
			return null;
		}
		await expectS3Ok(response, "GetBucketLifecycleConfiguration");
		return lifecycleExpirationDays(await response.text());
	}

	/**
	 * Expires every object `days` after it was written, or removes the
	 * lifecycle configuration when `days` is null. Replaces whatever
	 * lifecycle rules the bucket had.
	 *
	 * @throws With the store's own error.
	 */
	async setExpirationDays(name: string, days: number | null): Promise<void> {
		if (days === null) {
			await expectS3Ok(
				await s3Fetch(
					this.#credentials,
					{ method: "DELETE", path: `/${name}`, query: { lifecycle: "" } },
					this.#fetch,
				),
				"DeleteBucketLifecycle",
			);
			return;
		}
		const body = lifecycleXml(days);
		await expectS3Ok(
			await s3Fetch(
				this.#credentials,
				{
					body,
					headers: {
						"content-md5": createHash("md5").update(body).digest("base64"),
						"content-type": "application/xml",
					},
					method: "PUT",
					path: `/${name}`,
					query: { lifecycle: "" },
				},
				this.#fetch,
			),
			"PutBucketLifecycleConfiguration",
		);
	}

	/**
	 * An object's body as text, or null when it doesn't exist.
	 *
	 * @throws When the store refuses the request for another reason.
	 */
	async getObject(bucket: string, key: string): Promise<string | null> {
		const response = await s3Fetch(
			this.#credentials,
			{ method: "GET", path: `/${bucket}/${key}` },
			this.#fetch,
		);
		if (response.status === 404) {
			return null;
		}
		await expectS3Ok(response, "GetObject");
		return await response.text();
	}

	/**
	 * One page of what sits directly under `prefix` in a bucket, the way a
	 * file browser shows a folder: the sub-folders (common prefixes ending in
	 * "/") and the objects, plus the token for the next page.
	 *
	 * @throws When the bucket can't be listed.
	 */
	async listObjects(
		bucket: string,
		prefix: string,
		token: string | null,
	): Promise<ObjectListing> {
		const query: Record<string, string> = {
			delimiter: "/",
			"list-type": "2",
			"max-keys": "200",
			prefix,
		};
		if (token) {
			query["continuation-token"] = token;
		}
		const response = await s3Fetch(
			this.#credentials,
			{ method: "GET", path: `/${bucket}`, query },
			this.#fetch,
		);
		await expectS3Ok(response, "ListObjectsV2");
		const xml = await response.text();
		return {
			folders: blocks(xml, "CommonPrefixes")
				.map((entry) => tagValue(entry, "Prefix"))
				.filter((value): value is string => value !== null),
			nextToken:
				tagValue(xml, "IsTruncated") === "true"
					? tagValue(xml, "NextContinuationToken")
					: null,
			objects: blocks(xml, "Contents")
				.map((entry) => ({
					key: tagValue(entry, "Key") ?? "",
					lastModified: tagValue(entry, "LastModified"),
					size: Number.parseInt(tagValue(entry, "Size") ?? "0", 10),
				}))
				.filter((object) => object.key !== "" && object.key !== prefix),
		};
	}

	/**
	 * Deletes one object. Deleting a key that doesn't exist succeeds, as S3 does.
	 *
	 * @throws With the store's own error.
	 */
	async deleteObject(bucket: string, key: string): Promise<void> {
		await expectS3Ok(
			await s3Fetch(
				this.#credentials,
				{ method: "DELETE", path: `/${bucket}/${key}` },
				this.#fetch,
			),
			"DeleteObject",
		);
	}

	/**
	 * The store's own response for an object, body unread, so it can be
	 * streamed on: a `range` ("bytes=0-99") is passed through, and a missing
	 * object comes back as the store's 404.
	 */
	async objectResponse(
		bucket: string,
		key: string,
		range: string | null,
	): Promise<Response> {
		return await s3Fetch(
			this.#credentials,
			{
				headers: range ? { range } : {},
				method: "GET",
				path: `/${bucket}/${key}`,
			},
			this.#fetch,
		);
	}

	/**
	 * Writes an object, replacing any object at the same key.
	 *
	 * @throws With the store's own error.
	 */
	async putObject(
		bucket: string,
		key: string,
		body: string | Uint8Array<ArrayBuffer>,
		contentType = "application/octet-stream",
	): Promise<void> {
		await expectS3Ok(
			await s3Fetch(
				this.#credentials,
				{
					body,
					headers: { "content-type": contentType },
					method: "PUT",
					path: `/${bucket}/${key}`,
				},
				this.#fetch,
			),
			"PutObject",
		);
	}
}
