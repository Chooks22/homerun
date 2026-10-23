import { describe, expect, test } from "bun:test";
import {
	buildServerCandidates,
	buildServerChoice,
	buildServerPick,
	isBuildConcurrency,
	pickBuildServer,
} from "../../../src/lib/build-servers";
import { settings } from "../../../src/lib/settings";

const ANY = settings.docker.anyBuildServer;

const host = { buildServerAny: false, buildServerRemoteHostId: null };

describe("buildServerChoice", () => {
	test("the any pick sets the flag and no host", () => {
		expect(
			buildServerChoice({
				buildServer: ANY,
				buildSource: "git",
			}),
		).toEqual({ buildServerAny: true, buildServerRemoteHostId: null });
	});

	test("a host id pins that host", () => {
		expect(
			buildServerChoice({ buildServer: "h1", buildSource: "git" }),
		).toEqual({ buildServerAny: false, buildServerRemoteHostId: "h1" });
	});

	test("no pick, or an image service, builds here", () => {
		expect(buildServerChoice({ buildSource: "git" })).toEqual(host);
		expect(
			buildServerChoice({
				buildServer: "h1",
				buildSource: "image",
			}),
		).toEqual(host);
	});

	test("buildServerPick round-trips the picker value", () => {
		for (const value of ["", "h1", ANY]) {
			expect(
				buildServerPick(
					buildServerChoice({
						buildServer: value,
						buildSource: "git",
					}),
				),
			).toBe(value);
		}
	});
});

describe("buildServerCandidates", () => {
	const serverIds = ["a", "b"];

	test("a pinned server is the only candidate", () => {
		expect(
			buildServerCandidates({
				buildOnHost: false,
				choice: { buildServerAny: false, buildServerRemoteHostId: "b" },
				serverIds,
			}),
		).toEqual(["b"]);
	});

	test("any free server takes every registered one", () => {
		expect(
			buildServerCandidates({
				buildOnHost: true,
				choice: { buildServerAny: true, buildServerRemoteHostId: null },
				serverIds,
			}),
		).toEqual(serverIds);
	});

	test("building here when the instance allows it", () => {
		expect(
			buildServerCandidates({ buildOnHost: true, choice: host, serverIds }),
		).toEqual([]);
	});

	test("host builds turned off send the build to a server", () => {
		expect(
			buildServerCandidates({ buildOnHost: false, choice: host, serverIds }),
		).toEqual(serverIds);
	});

	test("with no server registered it still builds here", () => {
		expect(
			buildServerCandidates({
				buildOnHost: false,
				choice: { buildServerAny: true, buildServerRemoteHostId: null },
				serverIds: [],
			}),
		).toEqual([]);
	});
});

describe("pickBuildServer", () => {
	test("picks the least busy server with a free slot", () => {
		expect(
			pickBuildServer([
				{ active: 2, id: "a", limit: 4 },
				{ active: 1, id: "b", limit: 4 },
				{ active: 0, id: "c", limit: 0 },
			]),
		).toBe("c");
	});

	test("skips a full server", () => {
		expect(
			pickBuildServer([
				{ active: 1, id: "a", limit: 1 },
				{ active: 3, id: "b", limit: 4 },
			]),
		).toBe("b");
	});

	test("a limit of 0 never fills up", () => {
		expect(pickBuildServer([{ active: 50, id: "a", limit: 0 }])).toBe("a");
	});

	test("null when every server is full", () => {
		expect(
			pickBuildServer([
				{ active: 1, id: "a", limit: 1 },
				{ active: 2, id: "b", limit: 2 },
			]),
		).toBeNull();
	});

	test("breaks ties at random", () => {
		const slots = [
			{ active: 0, id: "a", limit: 1 },
			{ active: 0, id: "b", limit: 1 },
		];
		expect(pickBuildServer(slots, () => 0)).toBe("a");
		expect(pickBuildServer(slots, () => 0.99)).toBe("b");
	});
});

describe("isBuildConcurrency", () => {
	test("accepts 0 to the maximum, whole numbers only", () => {
		expect(isBuildConcurrency(0)).toBe(true);
		expect(isBuildConcurrency(4)).toBe(true);
		expect(isBuildConcurrency(64)).toBe(true);
		expect(isBuildConcurrency(65)).toBe(false);
		expect(isBuildConcurrency(-1)).toBe(false);
		expect(isBuildConcurrency(1.5)).toBe(false);
		expect(isBuildConcurrency(Number.NaN)).toBe(false);
	});
});
