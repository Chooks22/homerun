import { describe, expect, test } from "bun:test";

const { ObjectStoreClient } = await import(
	"../../../src/lib/services/s3/object-store-client"
);

interface Call {
	body: string | null;
	headers: Record<string, string>;
	method: string;
	url: URL;
}

function fakeStore(
	respond: (call: Call) => Response,
	region = "garage",
): { calls: Call[]; client: InstanceType<typeof ObjectStoreClient> } {
	const calls: Call[] = [];
	const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
		const call = {
			body: typeof init?.body === "string" ? init.body : null,
			headers: (init?.headers ?? {}) as Record<string, string>,
			method: init?.method ?? "GET",
			url: new URL(String(input)),
		};
		calls.push(call);
		return respond(call);
	};
	return {
		calls,
		client: new ObjectStoreClient(
			{
				accessKeyId: "key",
				endpoint: "http://s3.test",
				region,
				secretAccessKey: "secret",
			},
			fetcher as unknown as typeof fetch,
		),
	};
}

describe("ObjectStoreClient", () => {
	test("lists buckets by name", async () => {
		const { client } = fakeStore(
			() =>
				new Response(
					"<ListAllMyBucketsResult><Buckets><Bucket><Name>zeta</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket><Bucket><Name>alpha</Name></Bucket></Buckets></ListAllMyBucketsResult>",
				),
		);
		expect(await client.listBuckets()).toEqual([
			{ createdAt: null, name: "alpha" },
			{ createdAt: "2026-01-01T00:00:00Z", name: "zeta" },
		]);
	});

	test("creates a bucket in the store's region, except AWS's default one", async () => {
		const elsewhere = fakeStore(() => new Response(""), "eu-central-1");
		await elsewhere.client.createBucket("b");
		expect(elsewhere.calls[0].method).toBe("PUT");
		expect(elsewhere.calls[0].body).toContain(
			"<LocationConstraint>eu-central-1</LocationConstraint>",
		);
		const useast = fakeStore(() => new Response(""), "us-east-1");
		await useast.client.createBucket("b");
		expect(useast.calls[0].body).toBeNull();
	});

	test("says a bucket still holds objects instead of S3's 409", async () => {
		const { client } = fakeStore(() => new Response("", { status: 409 }));
		await expect(client.deleteBucket("full")).rejects.toThrow(
			"full still holds objects",
		);
	});

	test("empties a bucket page by page with DeleteObjects", async () => {
		let listed = 0;
		const { calls, client } = fakeStore((call) => {
			if (call.method === "POST") {
				return new Response("<DeleteResult></DeleteResult>");
			}
			listed += 1;
			return new Response(
				listed === 1
					? "<ListBucketResult><Contents><Key>a&amp;b</Key></Contents><Contents><Key>c</Key></Contents></ListBucketResult>"
					: "<ListBucketResult></ListBucketResult>",
			);
		});
		expect(await client.emptyBucket("b")).toBe(2);
		const del = calls.find((call) => call.method === "POST");
		expect(del?.url.searchParams.has("delete")).toBe(true);
		expect(del?.body).toContain("<Key>a&amp;b</Key>");
		expect(del?.body).toContain("<Key>c</Key>");
		expect(del?.headers["content-md5"]).toBeTruthy();
	});

	test("reports the first key DeleteObjects refused", async () => {
		const { client } = fakeStore((call) =>
			call.method === "POST"
				? new Response(
						"<DeleteResult><Error><Key>c</Key><Code>AccessDenied</Code><Message>Nope</Message></Error></DeleteResult>",
					)
				: new Response(
						"<ListBucketResult><Contents><Key>c</Key></Contents></ListBucketResult>",
					),
		);
		await expect(client.emptyBucket("b")).rejects.toThrow(
			"Couldn't delete c: Nope",
		);
	});

	test("counts usage across pages and stops at the cap", async () => {
		const page = (keys: number, next: string | null) =>
			new Response(
				`<ListBucketResult>${"<Contents><Key>k</Key><Size>10</Size></Contents>".repeat(keys)}<IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
			);
		const full = fakeStore((call) =>
			call.url.searchParams.get("continuation-token") === "t2"
				? page(2, null)
				: page(3, "t2"),
		);
		expect(await full.client.usage("b")).toEqual({
			bytes: 50,
			capped: false,
			objects: 5,
		});
		expect(full.calls[1].url.searchParams.get("continuation-token")).toBe("t2");

		const capped = fakeStore(() => page(3, "more"));
		expect(await capped.client.usage("b", 3)).toEqual({
			bytes: 30,
			capped: true,
			objects: 3,
		});
	});

	test("reads, writes and clears the expiry rule", async () => {
		const missing = fakeStore(() => new Response("", { status: 404 }));
		expect(await missing.client.expirationDays("b")).toBeNull();

		const { calls, client } = fakeStore(
			() =>
				new Response(
					"<LifecycleConfiguration><Rule><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule></LifecycleConfiguration>",
				),
		);
		expect(await client.expirationDays("b")).toBe(7);
		await client.setExpirationDays("b", 30);
		expect(calls[1].method).toBe("PUT");
		expect(calls[1].url.search).toBe("?lifecycle=");
		expect(calls[1].headers["content-md5"]).toBeTruthy();
		expect(calls[1].body).toContain("<Days>30</Days>");
		await client.setExpirationDays("b", null);
		expect(calls[2].method).toBe("DELETE");
	});

	test("gets an object, null when it's missing, and puts one", async () => {
		const { calls, client } = fakeStore((call) =>
			call.url.pathname.endsWith("/missing")
				? new Response("", { status: 404 })
				: new Response('{"serial":1}'),
		);
		expect(await client.getObject("b", "state")).toBe('{"serial":1}');
		expect(await client.getObject("b", "missing")).toBeNull();
		await client.putObject("b", "dir/k", "body", "application/json");
		expect(calls[2].url.pathname).toBe("/b/dir/k");
		expect(calls[2].headers["content-type"]).toBe("application/json");
	});

	test("lists a folder: its sub-folders, its objects with decoded keys, and the next page", async () => {
		const { calls, client } = fakeStore(
			() =>
				new Response(
					"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>docs/</Key><Size>0</Size></Contents><Contents><Key>docs/a &amp; b.txt</Key><LastModified>2026-10-01T00:00:00Z</LastModified><Size>12</Size></Contents><CommonPrefixes><Prefix>docs/img/</Prefix></CommonPrefixes></ListBucketResult>",
				),
		);
		expect(await client.listObjects("files", "docs/", null)).toEqual({
			folders: ["docs/img/"],
			nextToken: "t2",
			objects: [
				{
					key: "docs/a & b.txt",
					lastModified: "2026-10-01T00:00:00Z",
					size: 12,
				},
			],
		});
		expect(calls[0].url.searchParams.get("delimiter")).toBe("/");
		expect(calls[0].url.searchParams.get("prefix")).toBe("docs/");
	});
});
