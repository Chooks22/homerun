import { describe, expect, test } from "bun:test";
import {
	isPinnableTag,
	isValidTag,
	newerVersionTag,
	parseVersionTag,
	sanitizeTag,
	suggestLocalTag,
	tagsMatchingDigest,
} from "../../../src/lib/image-versions";

describe("parseVersionTag", () => {
	test("reads numbers, suffix and prerelease-ness", () => {
		expect(parseVersionTag("1.24.3")).toMatchObject({
			numbers: [1, 24, 3],
			prerelease: false,
			suffix: null,
		});
		expect(parseVersionTag("v2.1-rootless")).toMatchObject({
			numbers: [2, 1],
			prerelease: false,
			suffix: "rootless",
		});
		expect(parseVersionTag("1.25.0-dev-123-gabc")).toMatchObject({
			numbers: [1, 25, 0],
			prerelease: true,
		});
	});

	test("treats floating tags as no version", () => {
		expect(parseVersionTag("latest")).toBeNull();
		expect(parseVersionTag("nightly")).toBeNull();
		expect(parseVersionTag("sha-abc123")).toBeNull();
	});
});

describe("newerVersionTag", () => {
	const gitea = [
		"latest",
		"nightly",
		"1",
		"1.24",
		"1.24.3",
		"1.24.3-rootless",
		"1.24.4",
		"1.25-nightly",
		"1.25.0-rc1",
	];

	test("finds the newest stable release on the same track", () => {
		expect(newerVersionTag("1.24.3", gitea)).toBe("1.24.4");
		expect(
			newerVersionTag("1.24.3-rootless", [...gitea, "1.24.5-rootless"]),
		).toBe("1.24.5-rootless");
	});

	test("keeps a nightly-based pin waiting for its release, ignoring release candidates", () => {
		expect(newerVersionTag("1.25.0-dev-123", gitea)).toBeNull();
		expect(
			newerVersionTag("1.25.0-dev-123", [...gitea, "1.25", "1.25.0"]),
		).toBe("1.25.0");
	});

	test("never drops precision or follows a floating tag", () => {
		expect(newerVersionTag("1.24.4", gitea)).toBeNull();
		expect(newerVersionTag("latest", gitea)).toBeNull();
	});
});

describe("tagsMatchingDigest", () => {
	test("lists the most specific stable version first and skips the current tag", () => {
		const tags = [
			{ digest: "sha256:a", name: "latest" },
			{ digest: "sha256:a", name: "1" },
			{ digest: "sha256:a", name: "1.24" },
			{ digest: "sha256:a", name: "1.24.4" },
			{ digest: "sha256:b", name: "1.24.3" },
			{ digest: "sha256:a", name: "1.24-nightly" },
		];
		expect(tagsMatchingDigest(tags, "sha256:a", "latest")).toEqual([
			"1.24.4",
			"1.24",
			"1",
			"1.24-nightly",
		]);
	});
});

describe("local tags", () => {
	test("sanitizes free text into a valid tag", () => {
		expect(sanitizeTag(" 1.25.0+dev 12 ")).toBe("1.25.0-dev-12");
		expect(isValidTag("1.25.0-dev")).toBe(true);
		expect(isValidTag("bad tag")).toBe(false);
		expect(isValidTag("")).toBe(false);
	});

	test("suggests the version label, else the tag stamped with today", () => {
		expect(suggestLocalTag("nightly", "1.25.0+dev-12-gabc")).toBe(
			"1.25.0-dev-12-gabc",
		);
		expect(
			suggestLocalTag("nightly", null, new Date("2026-10-12T10:00:00Z")),
		).toBe("nightly-20261012");
	});
});

describe("isPinnableTag", () => {
	test("only a stable version actually pins", () => {
		expect(isPinnableTag("1.24.4")).toBe(true);
		expect(isPinnableTag("1.24.4-rootless")).toBe(true);
		expect(isPinnableTag("nightly")).toBe(false);
		expect(isPinnableTag("main-nightly")).toBe(false);
		expect(isPinnableTag("1.25-nightly")).toBe(false);
	});
});
