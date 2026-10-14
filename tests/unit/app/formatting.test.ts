import { describe, expect, test } from "bun:test";
import {
	formatBytes,
	formatDate,
	getPasswordStrength,
	getPasswordStrengthMeta,
	SECRET_MASK,
	timeAgo,
} from "../../../src/lib/formatting";

describe("formatBytes", () => {
	test("scales to the largest whole unit, one decimal under ten", () => {
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
		expect(formatBytes(2 * 1024 ** 5)).toBe("2048 TB");
	});
});

test("formatDate prints a short date, or a dash when there's none", () => {
	expect(formatDate(null)).toBe("—");
	expect(formatDate(new Date(2026, 0, 5))).toBe("Jan 5, 2026");
});

test("timeAgo buckets into minutes, hours and days", () => {
	const ago = (ms: number) => new Date(Date.now() - ms);
	expect(timeAgo(ago(30_000))).toBe("just now");
	expect(timeAgo(ago(5 * 60_000))).toBe("5m ago");
	expect(timeAgo(ago(3 * 3_600_000).toISOString())).toBe("3h ago");
	expect(timeAgo(ago(2 * 86_400_000))).toBe("2d ago");
});

describe("password strength", () => {
	test("one point each for length, an uppercase letter, a digit and a symbol", () => {
		expect(getPasswordStrength("")).toBe(0);
		expect(getPasswordStrength("abc")).toBe(0);
		expect(getPasswordStrength("abcdefghijkl")).toBe(1);
		expect(getPasswordStrength("Abcdefghijk1!")).toBe(4);
	});

	test("maps each score to its label", () => {
		expect(
			[0, 1, 2, 3, 4].map((score) => getPasswordStrengthMeta(score).label),
		).toEqual(["", "Weak", "Fair", "Good", "Strong"]);
	});
});

describe("SECRET_MASK", () => {
	test("is one fixed, long run of bullets", () => {
		expect(SECRET_MASK).toBe("•".repeat(24));
	});
});
