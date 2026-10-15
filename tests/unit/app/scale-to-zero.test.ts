import { describe, expect, test } from "bun:test";
import {
	scaleToZeroLabel,
	shouldSleep,
	wakeRedirectTarget,
} from "../../../src/lib/scale-to-zero";

const now = new Date("2026-10-15T12:00:00Z");
const minutesAgo = (minutes: number) =>
	new Date(now.getTime() - minutes * 60_000);

describe("shouldSleep", () => {
	test("sleeps once the last request is older than the idle minutes", () => {
		expect(
			shouldSleep({
				lastRequestAt: minutesAgo(16),
				minutes: 15,
				now,
				watchingSince: minutesAgo(600),
				wokenAt: minutesAgo(600),
			}),
		).toBe(true);
	});

	test("stays awake while a recent request is inside the window", () => {
		expect(
			shouldSleep({
				lastRequestAt: minutesAgo(5),
				minutes: 15,
				now,
				watchingSince: minutesAgo(600),
				wokenAt: null,
			}),
		).toBe(false);
	});

	test("a recent wake restarts the idle clock even with no request since", () => {
		expect(
			shouldSleep({
				lastRequestAt: null,
				minutes: 15,
				now,
				watchingSince: minutesAgo(600),
				wokenAt: minutesAgo(2),
			}),
		).toBe(false);
	});

	test("never judges a minute the sampler didn't watch", () => {
		expect(
			shouldSleep({
				lastRequestAt: null,
				minutes: 15,
				now,
				watchingSince: minutesAgo(3),
				wokenAt: null,
			}),
		).toBe(false);
	});

	test("the boundary minute counts as idle", () => {
		expect(
			shouldSleep({
				lastRequestAt: minutesAgo(15),
				minutes: 15,
				now,
				watchingSince: minutesAgo(600),
				wokenAt: null,
			}),
		).toBe(true);
	});
});

describe("wakeRedirectTarget", () => {
	test("sends the request back to its original path and query", () => {
		expect(wakeRedirectTarget("/api/items", "?page=2")).toBe(
			"/api/items?page=2",
		);
	});

	test("refuses anything that isn't a same-host path", () => {
		expect(wakeRedirectTarget(null, "")).toBeNull();
		expect(wakeRedirectTarget("//evil.example", "")).toBeNull();
		expect(wakeRedirectTarget("https://evil.example", "")).toBeNull();
	});
});

describe("scaleToZeroLabel", () => {
	test("says minutes, or hours when it divides evenly", () => {
		expect(scaleToZeroLabel(1)).toBe("Sleeps after 1 minute without a request");
		expect(scaleToZeroLabel(15)).toBe(
			"Sleeps after 15 minutes without a request",
		);
		expect(scaleToZeroLabel(120)).toBe(
			"Sleeps after 2 hours without a request",
		);
	});
});
