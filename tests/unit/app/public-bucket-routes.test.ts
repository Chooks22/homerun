import { describe, expect, test } from "bun:test";
import {
	publicBucketsConfig,
	publicBucketUrl,
} from "../../../src/lib/public-bucket-routes";

const base = {
	certResolver: "letsencrypt",
	entrypoint: "websecure",
	host: "s3.example.com",
	storeId: "store-1",
	target: "http://homerun-auth:3000",
};

describe("publicBucketUrl", () => {
	test("uses the built-in store's published hostname", () => {
		expect(
			publicBucketUrl({
				bucket: "media",
				origin: "https://homerun.example.com",
				publicHost: "s3.example.com",
				storeId: "store-1",
				storeKind: "garage",
			}),
		).toBe("https://s3.example.com/media/");
	});

	test("falls back to the instance's /public route", () => {
		expect(
			publicBucketUrl({
				bucket: "media",
				origin: "https://homerun.example.com",
				publicHost: null,
				storeId: "store-1",
				storeKind: "garage",
			}),
		).toBe("https://homerun.example.com/public/store-1/media/");
		expect(
			publicBucketUrl({
				bucket: "media",
				origin: "https://homerun.example.com",
				publicHost: "s3.example.com",
				storeId: "store-2",
				storeKind: "s3",
			}),
		).toBe("https://homerun.example.com/public/store-2/media/");
	});
});

describe("publicBucketsConfig", () => {
	test("is null without a host or a public bucket", () => {
		expect(publicBucketsConfig({ ...base, buckets: [] })).toBeNull();
		expect(
			publicBucketsConfig({ ...base, buckets: ["media"], host: null }),
		).toBeNull();
	});

	test("routes unsigned reads of each public bucket to the app's /public route", () => {
		const yaml = publicBucketsConfig({ ...base, buckets: ["media", "a.b"] });
		expect(yaml).toContain(
			"rule: Host(`s3.example.com`) && PathPrefix(`/media/`) && (Method(`GET`) || Method(`HEAD`)) && !HeaderRegexp(`Authorization`, `.+`) && !QueryRegexp(`X-Amz-Signature`, `.+`)",
		);
		expect(yaml).toContain("PathPrefix(`/a.b/`)");
		expect(yaml).toContain("prefix: /public/store-1");
		expect(yaml).toContain("- url: http://homerun-auth:3000");
		expect(yaml).toContain("certResolver: letsencrypt");
	});
});
