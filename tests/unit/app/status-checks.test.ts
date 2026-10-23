import { describe, expect, test } from "bun:test";
import {
	type CheckResult,
	type CheckTarget,
	checkRound,
	evaluateChecks,
	inferProviderKind,
	mapBitbucketStatuses,
	mapGiteaStatuses,
	mapGitHubCheckRuns,
	mapGitHubStatuses,
	mapGitLabPipelines,
	mapGitLabStatuses,
	mergeChecks,
	providerApiBase,
	repoPathFromGitUrl,
	StatusCheckApiError,
	StatusCheckClient,
} from "../../../src/lib/status-checks";

const SHA = "a".repeat(40);

function fakeFetch(routes: Record<string, unknown>) {
	const calls: Array<{ headers: Record<string, string>; url: string }> = [];
	const impl = (url: string, init?: RequestInit) => {
		calls.push({
			headers: (init?.headers ?? {}) as Record<string, string>,
			url,
		});
		const match = Object.entries(routes).find(([suffix]) =>
			url.endsWith(suffix),
		);
		if (!match) {
			return Promise.resolve(new Response("not found", { status: 404 }));
		}
		return Promise.resolve(Response.json(match[1]));
	};
	return { calls, impl };
}

describe("repoPathFromGitUrl / inferProviderKind", () => {
	test("reads owner/repo from https, scp-style and nested GitLab groups", () => {
		expect(repoPathFromGitUrl("https://github.com/acme/api.git")).toBe(
			"acme/api",
		);
		expect(repoPathFromGitUrl("git@github.com:acme/api.git")).toBe("acme/api");
		expect(repoPathFromGitUrl("https://gitlab.com/group/sub/api")).toBe(
			"group/sub/api",
		);
		expect(repoPathFromGitUrl("https://tok@github.com/acme/api/")).toBe(
			"acme/api",
		);
	});

	test("strips a self-hosted base path and rejects a bare host", () => {
		expect(
			repoPathFromGitUrl(
				"https://git.example.com/gitea/acme/api.git",
				"https://git.example.com/gitea/",
			),
		).toBe("acme/api");
		expect(repoPathFromGitUrl("https://github.com/")).toBeNull();
		expect(repoPathFromGitUrl("not a url")).toBeNull();
	});

	test("well-known hosts map to a provider kind without any configuration", () => {
		expect(inferProviderKind("https://github.com/a/b.git")).toBe("github");
		expect(inferProviderKind("git@gitlab.com:a/b.git")).toBe("gitlab");
		expect(inferProviderKind("https://bitbucket.org/a/b.git")).toBe(
			"bitbucket",
		);
		expect(inferProviderKind("https://git.example.com/a/b.git")).toBeNull();
	});

	test("API bases per provider", () => {
		expect(providerApiBase("github", null)).toBe("https://api.github.com");
		expect(providerApiBase("gitlab", "https://gl.example.com/")).toBe(
			"https://gl.example.com/api/v4",
		);
		expect(providerApiBase("gitea", "https://git.example.com")).toBe(
			"https://git.example.com/api/v1",
		);
		expect(() => providerApiBase("gitea", null)).toThrow();
	});
});

describe("provider mappings", () => {
	test("GitHub check runs: running is pending, neutral/skipped pass, cancelled fails", () => {
		const results = mapGitHubCheckRuns({
			check_runs: [
				{ conclusion: null, name: "build", status: "in_progress" },
				{ conclusion: "success", name: "test", status: "completed" },
				{ conclusion: "neutral", name: "lint", status: "completed" },
				{ conclusion: "skipped", name: "deploy-preview", status: "completed" },
				{ conclusion: "cancelled", name: "e2e", status: "completed" },
				{ conclusion: "timed_out", name: "bench", status: "completed" },
			],
		});
		expect(results.map((r) => [r.name, r.state])).toEqual([
			["build", "pending"],
			["test", "success"],
			["lint", "success"],
			["deploy-preview", "success"],
			["e2e", "failure"],
			["bench", "failure"],
		]);
	});

	test("GitHub commit statuses", () => {
		expect(
			mapGitHubStatuses({
				statuses: [
					{ context: "ci/jenkins", state: "pending" },
					{ context: "ci/circle", state: "error" },
					{ context: "coverage", state: "success" },
				],
			}).map((r) => r.state),
		).toEqual(["pending", "failure", "success"]);
	});

	test("GitLab jobs honour allow_failure and manual jobs", () => {
		expect(
			mapGitLabStatuses([
				{ name: "build", status: "running" },
				{ name: "test", status: "failed" },
				{ allow_failure: true, name: "flaky", status: "failed" },
				{ name: "deploy", status: "manual" },
				{ allow_failure: true, name: "optional", status: "manual" },
				{ name: "docs", status: "skipped" },
				{ name: "cancelled", status: "canceled" },
			]).map((r) => [r.name, r.state]),
		).toEqual([
			["build", "pending"],
			["test", "failure"],
			["flaky", "success"],
			["deploy", "pending"],
			["optional", "success"],
			["docs", "success"],
			["cancelled", "failure"],
		]);
		expect(
			mapGitLabPipelines([{ status: "success" }, { status: "failed" }]),
		).toEqual([{ detail: "success", name: "pipeline", state: "success" }]);
		expect(mapGitLabPipelines([])).toEqual([]);
	});

	test("Gitea/Forgejo statuses, including the older state field and warning", () => {
		expect(
			mapGiteaStatuses({
				statuses: [
					{ context: "ci/woodpecker", status: "success" },
					{ context: "actions / test", status: "failure" },
					{ context: "lint", state: "warning" },
					{ context: "slow", status: "pending" },
				],
			}).map((r) => r.state),
		).toEqual(["success", "failure", "success", "pending"]);
		expect(mapGiteaStatuses({ statuses: null })).toEqual([]);
	});

	test("Bitbucket statuses are keyed by key, STOPPED fails", () => {
		expect(
			mapBitbucketStatuses({
				values: [
					{ key: "pipeline-build", state: "SUCCESSFUL" },
					{ key: "tests", state: "INPROGRESS" },
					{ key: "e2e", state: "STOPPED" },
					{ key: "lint", state: "FAILED" },
				],
			}).map((r) => [r.name, r.state]),
		).toEqual([
			["pipeline-build", "success"],
			["tests", "pending"],
			["e2e", "failure"],
			["lint", "failure"],
		]);
	});

	test("a name reported twice keeps its most pessimistic state", () => {
		const merged = mergeChecks([
			{ detail: null, name: "build", state: "success" },
			{ detail: null, name: "build", state: "failure" },
			{ detail: null, name: "test", state: "pending" },
			{ detail: null, name: "test", state: "success" },
		]);
		expect(merged.map((r) => [r.name, r.state])).toEqual([
			["build", "failure"],
			["test", "pending"],
		]);
	});
});

function result(name: string, state: CheckResult["state"]): CheckResult {
	return { detail: null, name, state };
}

describe("evaluateChecks", () => {
	test("passes only when every required check passed, ignoring unrelated ones", () => {
		const evaluation = evaluateChecks(
			["build", "test"],
			[
				result("build", "success"),
				result("test", "success"),
				result("other", "failure"),
			],
			false,
		);
		expect(evaluation.outcome).toBe("pass");
		expect(evaluation.passed).toEqual(["build", "test"]);
	});

	test("any failed required check fails, even with others still running", () => {
		const evaluation = evaluateChecks(
			["build", "test"],
			[result("build", "pending"), result("test", "failure")],
			false,
		);
		expect(evaluation.outcome).toBe("fail");
		expect(evaluation.failed).toEqual(["test"]);
		expect(evaluation.pending).toEqual(["build"]);
	});

	test("a missing check waits while anything runs or before the grace period", () => {
		expect(evaluateChecks(["e2e"], [], false).outcome).toBe("pending");
		expect(
			evaluateChecks(["e2e"], [result("build", "pending")], true).outcome,
		).toBe("pending");
		expect(
			evaluateChecks(["e2e"], [result("build", "success")], false).outcome,
		).toBe("pending");
	});

	test("a missing check fails once everything else finished and the grace expired", () => {
		const evaluation = evaluateChecks(
			["build", "e2e"],
			[result("build", "success")],
			true,
		);
		expect(evaluation.outcome).toBe("fail");
		expect(evaluation.missing).toEqual(["e2e"]);
	});

	test("a commit nothing reports on fails once the grace expired", () => {
		expect(evaluateChecks(["prek"], [], true).outcome).toBe("fail");
	});
});

describe("StatusCheckClient", () => {
	test("GitHub merges check runs and commit statuses for the resolved commit", async () => {
		const target: CheckTarget = {
			api: "https://api.github.com",
			kind: "github",
			repo: "acme/api",
			token: "tok",
		};
		const { calls, impl } = fakeFetch({
			[`/repos/acme/api/commits/${SHA}/check-runs?per_page=100&filter=latest`]:
				{
					check_runs: [
						{ conclusion: "success", name: "build", status: "completed" },
					],
				},
			[`/repos/acme/api/commits/${SHA}/status?per_page=100`]: {
				statuses: [{ context: "ci/legacy", state: "pending" }],
			},
			"/repos/acme/api/commits?sha=main&per_page=1": [{ sha: SHA }],
		});
		const client = new StatusCheckClient(target, impl);
		expect(await client.resolveCommit("main")).toBe(SHA);
		const checks = await client.checks(SHA);
		expect(checks.map((c) => [c.name, c.state])).toEqual([
			["build", "success"],
			["ci/legacy", "pending"],
		]);
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("GitLab URL-encodes the project path and adds the pipeline", async () => {
		const target: CheckTarget = {
			api: "https://gitlab.com/api/v4",
			kind: "gitlab",
			repo: "group/sub/api",
			token: null,
		};
		const project = "group%2Fsub%2Fapi";
		const { calls, impl } = fakeFetch({
			[`/projects/${project}/pipelines?sha=${SHA}&per_page=1`]: [
				{ status: "running" },
			],
			[`/projects/${project}/repository/commits/${SHA}/statuses?all=false&per_page=100`]:
				[{ name: "test", status: "success" }],
			[`/projects/${project}/repository/commits?ref_name=main&per_page=5`]: [
				{ id: SHA },
			],
		});
		const client = new StatusCheckClient(target, impl);
		expect(await client.checkNames("main")).toEqual(["pipeline", "test"]);
		expect(calls[0]?.headers.Authorization).toBeUndefined();
	});

	test("Gitea and Bitbucket read their own commit and status shapes", async () => {
		const gitea = fakeFetch({
			[`/repos/acme/api/commits/${SHA}/status`]: {
				statuses: [{ context: "ci", status: "failure" }],
			},
			"/repos/acme/api/commits?sha=main&limit=1&stat=false&verification=false&files=false":
				[{ sha: SHA }],
		});
		const giteaClient = new StatusCheckClient(
			{
				api: "https://git.example.com/api/v1",
				kind: "gitea",
				repo: "acme/api",
				token: "t",
			},
			gitea.impl,
		);
		expect(await giteaClient.resolveCommit("main")).toBe(SHA);
		expect((await giteaClient.checks(SHA))[0]?.state).toBe("failure");

		const bitbucket = fakeFetch({
			[`/repositories/acme/api/commit/${SHA}/statuses?pagelen=100`]: {
				values: [{ key: "build", state: "SUCCESSFUL" }],
			},
			"/repositories/acme/api/commits/main?pagelen=1": {
				values: [{ hash: SHA }],
			},
		});
		const bitbucketClient = new StatusCheckClient(
			{
				api: "https://api.bitbucket.org/2.0",
				kind: "bitbucket",
				repo: "acme/api",
				token: null,
			},
			bitbucket.impl,
		);
		expect(await bitbucketClient.resolveCommit("main")).toBe(SHA);
		expect((await bitbucketClient.checks(SHA))[0]?.name).toBe("build");
	});

	test("an API error carries its status and a 404 is permanent", async () => {
		const client = new StatusCheckClient(
			{
				api: "https://api.github.com",
				kind: "github",
				repo: "acme/gone",
				token: null,
			},
			fakeFetch({}).impl,
		);
		const error = await client.resolveCommit("main").catch((err) => err);
		expect(error).toBeInstanceOf(StatusCheckApiError);
		expect((error as StatusCheckApiError).permanent).toBe(true);
		expect(new StatusCheckApiError("x", 502).permanent).toBe(false);
	});
});

describe("checkRound", () => {
	const base = {
		graceMs: 60_000,
		required: ["build"],
		timeoutMs: 120_000,
		waitedMs: 0,
	};
	const checks =
		(...results: CheckResult[]) =>
		() =>
			Promise.resolve(results);

	test("passes, fails or stays pending on what the provider reports", async () => {
		const pass = await checkRound({
			...base,
			fetchChecks: checks(result("build", "success")),
		});
		expect(pass.outcome).toBe("pass");
		const fail = await checkRound({
			...base,
			fetchChecks: checks(result("build", "failure")),
		});
		expect(fail.outcome).toBe("fail");
		const pending = await checkRound({
			...base,
			fetchChecks: checks(result("build", "pending")),
		});
		expect(pending.outcome).toBe("pending");
	});

	test("times out with the evaluation once the wait is over", async () => {
		const round = await checkRound({
			...base,
			fetchChecks: checks(result("build", "pending")),
			waitedMs: 120_000,
		});
		expect(round).toMatchObject({
			evaluation: { pending: ["build"] },
			outcome: "timeout",
		});
	});

	test("a check that never reports fails only once the grace period is over", async () => {
		const early = await checkRound({
			...base,
			fetchChecks: checks(result("lint", "success")),
		});
		expect(early.outcome).toBe("pending");
		const late = await checkRound({
			...base,
			fetchChecks: checks(result("lint", "success")),
			waitedMs: 60_000,
		});
		expect(late).toMatchObject({
			evaluation: { missing: ["build"] },
			outcome: "fail",
		});
	});

	test("transient API errors retry until the wait is over, permanent ones throw", async () => {
		const flaky = () =>
			Promise.reject(new StatusCheckApiError("bad gateway", 502));
		expect(await checkRound({ ...base, fetchChecks: flaky })).toEqual({
			outcome: "retry",
			reason: "bad gateway",
		});
		const late = await checkRound({
			...base,
			fetchChecks: flaky,
			waitedMs: 120_000,
		});
		expect(late.outcome).toBe("timeout");
		await expect(
			checkRound({
				...base,
				fetchChecks: () => Promise.reject(new StatusCheckApiError("nope", 401)),
			}),
		).rejects.toBeInstanceOf(StatusCheckApiError);
	});
});
