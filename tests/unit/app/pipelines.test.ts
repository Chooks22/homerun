import { describe, expect, test } from "bun:test";
import {
	billableMinutes,
	defaultRates,
	formatRates,
	parseRates,
	rateFor,
} from "../../../src/lib/pipelines/cost";
import {
	formatCompactDuration,
	formatUsd,
} from "../../../src/lib/pipelines/list";
import {
	buildPipelineTrace,
	pipelineTraceId,
} from "../../../src/lib/pipelines/otlp";
import {
	gitLabTitle,
	mapActionsJob,
	mapActionsRun,
	mapGitLabJob,
	mapGitLabPipeline,
	PipelineClient,
	pipelineServiceName,
} from "../../../src/lib/pipelines/providers";
import { recostJobs, summarizeRun } from "../../../src/lib/pipelines/summary";
import {
	type FetchedJob,
	type FetchedRun,
	normalizeStatus,
} from "../../../src/lib/pipelines/types";
import {
	pipelineSpanToken,
	validPipelineSpanToken,
} from "../../../src/lib/tracing/ingest-token";
import { parseOtlpTraces, spanOwner } from "../../../src/lib/tracing/otlp";

const GITHUB_RUN = {
	actor: { login: "octo" },
	conclusion: "failure",
	created_at: "2026-10-01T10:00:00Z",
	display_title: "Fix the thing",
	event: "push",
	head_branch: "main",
	head_sha: "abc1234def",
	html_url: "https://github.com/o/r/actions/runs/42",
	id: 42,
	name: "CI",
	run_attempt: 2,
	run_number: 7,
	run_started_at: "2026-10-01T10:00:30Z",
	status: "completed",
	updated_at: "2026-10-01T10:05:00Z",
};

const GITHUB_JOB = {
	completed_at: "2026-10-01T10:03:10Z",
	conclusion: "failure",
	created_at: "2026-10-01T10:00:05Z",
	html_url: "https://github.com/o/r/actions/runs/42/job/1",
	labels: ["ubuntu-latest"],
	name: "test",
	runner_name: "GitHub Actions 3",
	started_at: "2026-10-01T10:01:00Z",
	status: "completed",
	steps: [
		{
			completed_at: "2026-10-01T10:01:05Z",
			conclusion: "success",
			name: "Checkout",
			started_at: "2026-10-01T10:01:00Z",
			status: "completed",
		},
		{
			completed_at: null,
			conclusion: "skipped",
			name: "Never ran",
			started_at: null,
			status: "completed",
		},
	],
};

function job(overrides: Partial<FetchedJob> = {}): FetchedJob {
	return {
		attempt: null,
		createdAt: "2026-10-01T10:00:00.000Z",
		finishedAt: "2026-10-01T10:02:30.000Z",
		labels: ["ubuntu-latest"],
		name: "build",
		runner: null,
		stage: null,
		startedAt: "2026-10-01T10:01:00.000Z",
		status: "success",
		steps: [],
		url: null,
		...overrides,
	};
}

function run(overrides: Partial<FetchedRun> = {}): FetchedRun {
	return {
		actor: null,
		attempt: 1,
		branch: "main",
		commitSha: "abc",
		createdAt: "2026-10-01T10:00:00.000Z",
		event: "push",
		externalId: "42",
		finishedAt: null,
		name: "CI",
		number: 7,
		startedAt: null,
		status: "success",
		title: null,
		url: null,
		...overrides,
	};
}

describe("normalizeStatus", () => {
	test("takes a completed run's conclusion", () => {
		expect(normalizeStatus("completed", "success")).toBe("success");
		expect(normalizeStatus("completed", "failure")).toBe("failure");
		expect(normalizeStatus("completed", "timed_out")).toBe("failure");
		expect(normalizeStatus("completed", "cancelled")).toBe("cancelled");
		expect(normalizeStatus("completed", "skipped")).toBe("skipped");
	});

	test("reads GitLab's and Gitea's bare statuses", () => {
		expect(normalizeStatus("running")).toBe("running");
		expect(normalizeStatus("in_progress", null)).toBe("running");
		expect(normalizeStatus("waiting_for_resource")).toBe("queued");
		expect(normalizeStatus("canceled")).toBe("cancelled");
		expect(normalizeStatus("failed")).toBe("failure");
		expect(normalizeStatus("success", "")).toBe("success");
	});

	test("reads anything unknown as queued", () => {
		expect(normalizeStatus("whatever")).toBe("queued");
		expect(normalizeStatus(undefined)).toBe("queued");
	});
});

describe("provider mapping", () => {
	test("maps a GitHub or Gitea Actions run", () => {
		expect(mapActionsRun(GITHUB_RUN)).toEqual({
			actor: "octo",
			attempt: 2,
			branch: "main",
			commitSha: "abc1234def",
			createdAt: "2026-10-01T10:00:00.000Z",
			event: "push",
			externalId: "42",
			finishedAt: null,
			name: "CI",
			number: 7,
			startedAt: "2026-10-01T10:00:30.000Z",
			status: "failure",
			title: "Fix the thing",
			url: "https://github.com/o/r/actions/runs/42",
		});
		expect(mapActionsRun({ name: "no id" })).toBeNull();
		expect(
			mapActionsRun({ ...GITHUB_RUN, html_url: "javascript:alert(1)" })?.url,
		).toBeNull();
	});

	test("names a Gitea run after its workflow file and ignores zero times", () => {
		const mapped = mapActionsRun({
			completed_at: "0001-01-01T00:00:00Z",
			id: 3,
			path: ".gitea/workflows/build.yaml@refs/heads/main",
			started_at: "2026-10-01T10:00:00Z",
			status: "success",
		});
		expect(mapped?.name).toBe("build.yaml");
		expect(mapped?.finishedAt).toBeNull();
		expect(mapped?.startedAt).toBe("2026-10-01T10:00:00.000Z");
	});

	test("maps an Actions job with its steps", () => {
		const mapped = mapActionsJob(GITHUB_JOB);
		expect(mapped?.status).toBe("failure");
		expect(mapped?.labels).toEqual(["ubuntu-latest"]);
		expect(mapped?.runner).toBe("GitHub Actions 3");
		expect(mapped?.steps).toEqual([
			{
				finishedAt: "2026-10-01T10:01:05.000Z",
				name: "Checkout",
				startedAt: "2026-10-01T10:01:00.000Z",
				status: "success",
			},
			{
				finishedAt: null,
				name: "Never ran",
				startedAt: null,
				status: "skipped",
			},
		]);
	});

	test("maps a GitLab pipeline and job", () => {
		expect(
			mapGitLabPipeline({
				created_at: "2026-10-01T10:00:00Z",
				id: 900,
				iid: 12,
				ref: "main",
				sha: "deadbeef",
				source: "push",
				status: "canceled",
				web_url: "https://gitlab.com/g/p/-/pipelines/900",
			}),
		).toMatchObject({
			externalId: "900",
			name: "pipeline",
			number: 12,
			status: "cancelled",
		});
		const gitlabJobs = [
			{
				commit: { title: "Bump deps" },
				finished_at: "2026-10-01T10:04:00Z",
				name: "lint",
				runner: { description: "shared-runner-1" },
				stage: "test",
				started_at: "2026-10-01T10:01:00Z",
				status: "success",
				tag_list: ["docker"],
			},
		];
		expect(mapGitLabJob(gitlabJobs[0])).toMatchObject({
			labels: ["docker"],
			runner: "shared-runner-1",
			stage: "test",
			status: "success",
			steps: [],
		});
		expect(gitLabTitle(gitlabJobs)).toBe("Bump deps");
		expect(gitLabTitle([])).toBeNull();
	});

	test("names each provider's CI as a service", () => {
		expect(pipelineServiceName("github")).toBe("github-actions");
		expect(pipelineServiceName("gitlab")).toBe("gitlab-ci");
		expect(pipelineServiceName("gitea")).toBe("gitea-actions");
	});
});

describe("PipelineClient", () => {
	function client(
		kind: "github" | "gitlab" | "gitea",
		responses: Record<string, unknown>,
		seen: string[],
	) {
		return new PipelineClient(
			{ api: "https://api.test", kind, repo: "group/sub/repo", token: "t" },
			(input) => {
				seen.push(input);
				const body = responses[input];
				return Promise.resolve(
					body === undefined
						? new Response("nope", { status: 404 })
						: Response.json(body),
				);
			},
		);
	}

	test("lists GitHub runs and jobs", async () => {
		const seen: string[] = [];
		const github = client(
			"github",
			{
				"https://api.test/repos/group/sub/repo/actions/runs/42/jobs?per_page=100&filter=all":
					{ jobs: [GITHUB_JOB] },
				"https://api.test/repos/group/sub/repo/actions/runs?per_page=20": {
					workflow_runs: [GITHUB_RUN],
				},
			},
			seen,
		);
		const [first] = await github.listRuns(20);
		expect(first?.externalId).toBe("42");
		const { jobs } = await github.listJobs(first as FetchedRun);
		expect(jobs).toHaveLength(1);
	});

	test("encodes a GitLab project path and caps the page at 100", async () => {
		const seen: string[] = [];
		const gitlab = client(
			"gitlab",
			{
				"https://api.test/projects/group%2Fsub%2Frepo/pipelines?per_page=100&order_by=id&sort=desc":
					[{ id: 1, status: "success" }],
			},
			seen,
		);
		expect(await gitlab.listRuns(500)).toHaveLength(1);
	});

	test("hints at the Gitea version on a 404", async () => {
		const gitea = client("gitea", {}, []);
		await expect(gitea.listRuns(10)).rejects.toThrow(
			"Gitea serves its Actions API from 1.24 on.",
		);
	});
});

describe("cost", () => {
	test("rounds each job up to whole minutes", () => {
		expect(
			billableMinutes("2026-10-01T10:00:00Z", "2026-10-01T10:00:01Z"),
		).toBe(1);
		expect(
			billableMinutes("2026-10-01T10:00:00Z", "2026-10-01T10:02:00Z"),
		).toBe(2);
		expect(billableMinutes("2026-10-01T10:00:00Z", null)).toBe(0);
		expect(
			billableMinutes("2026-10-01T10:05:00Z", "2026-10-01T10:00:00Z"),
		).toBe(0);
	});

	test("picks the first rule a runner label starts with", () => {
		const rules = defaultRates("github");
		expect(rateFor(rules, ["ubuntu-latest"], null)).toBe(0.006);
		expect(rateFor(rules, ["self-hosted", "linux", "x64"], null)).toBe(0);
		expect(rateFor(rules, ["macos-14"], null)).toBe(0.062);
		expect(rateFor(rules, ["Windows-2022"], null)).toBe(0.01);
		expect(rateFor(rules, ["arm-box"], null)).toBe(0);
		expect(rateFor([{ label: "big", rate: 1 }], [], "big-runner-3")).toBe(1);
		expect(defaultRates("gitea")).toEqual([]);
	});

	test("parses and formats rate lines", () => {
		const rules = parseRates(
			"ubuntu = 0.006\n\n  self-hosted=0  \nmacos = 0.062",
		);
		expect(rules).toEqual([
			{ label: "ubuntu", rate: 0.006 },
			{ label: "self-hosted", rate: 0 },
			{ label: "macos", rate: 0.062 },
		]);
		expect(parseRates(formatRates(rules))).toEqual(rules);
		expect(() => parseRates("ubuntu = cheap")).toThrow("Line 1");
		expect(() => parseRates("= 1")).toThrow("Line 1");
	});

	test("formats a duration short enough for a stat tile", () => {
		expect(formatCompactDuration(null)).toBe("—");
		expect(formatCompactDuration(850)).toBe("850ms");
		expect(formatCompactDuration(42_400)).toBe("42s");
		expect(formatCompactDuration(150_000)).toBe("2m 30s");
		expect(formatCompactDuration(3_900_000)).toBe("1h 5m");
	});

	test("formats dollars", () => {
		expect(formatUsd(0)).toBe("$0");
		expect(formatUsd(0.0123)).toBe("$0.012");
		expect(formatUsd(12.345)).toBe("$12.35");
	});
});

describe("summarizeRun", () => {
	const now = new Date("2026-10-02T00:00:00Z");

	test("times and costs a finished run from its jobs", () => {
		const summary = summarizeRun(
			run({ status: "success" }),
			{
				jobs: [
					job(),
					job({
						finishedAt: "2026-10-01T10:05:00.000Z",
						labels: ["macos-14"],
						name: "mac",
						startedAt: "2026-10-01T10:02:00.000Z",
					}),
				],
				title: "From the jobs",
			},
			defaultRates("github"),
			now,
		);
		expect(summary.queueMs).toBe(60_000);
		expect(summary.startedAt?.toISOString()).toBe("2026-10-01T10:01:00.000Z");
		expect(summary.finishedAt?.toISOString()).toBe("2026-10-01T10:05:00.000Z");
		expect(summary.durationMs).toBe(240_000);
		expect(summary.billableMinutes).toBe(5);
		expect(summary.costUsd).toBeCloseTo(2 * 0.006 + 3 * 0.062, 6);
		expect(summary.jobs[0]?.durationMs).toBe(90_000);
		expect(summary.title).toBe("From the jobs");
	});

	test("costs every attempt of a re-run but times only the latest", () => {
		const summary = summarizeRun(
			run({
				attempt: 2,
				createdAt: "2026-10-01T08:00:00.000Z",
				startedAt: "2026-10-01T10:00:00.000Z",
				status: "success",
			}),
			{
				jobs: [
					job({
						attempt: 1,
						finishedAt: "2026-10-01T08:10:00.000Z",
						startedAt: "2026-10-01T08:01:00.000Z",
						status: "failure",
					}),
					job({ attempt: 2 }),
				],
				title: null,
			},
			defaultRates("github"),
			now,
		);
		expect(summary.billableMinutes).toBe(11);
		expect(summary.costUsd).toBeCloseTo(11 * 0.006, 6);
		expect(summary.createdAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
		expect(summary.queueMs).toBe(60_000);
		expect(summary.durationMs).toBe(150_000);
		expect(summary.jobs.map((entry) => entry.attempt)).toEqual([1, 2]);
		const body = buildPipelineTrace({
			...summary,
			externalId: "42",
			pipelineToken: "token",
			provider: "github",
			repositoryId: "repo-1",
			serviceId: "svc-1",
		});
		const [resource] = parseOtlpTraces(body);
		expect(resource?.spans.map((span) => span.name)).toEqual(["CI", "build"]);
		expect(resource?.spans[0]?.startTime.toISOString()).toBe(
			"2026-10-01T10:00:00.000Z",
		);
	});

	test("leaves an unfinished run open and falls back on now", () => {
		const summary = summarizeRun(
			run({ createdAt: null, status: "running" }),
			{ jobs: [], title: null },
			[],
			now,
		);
		expect(summary.finishedAt).toBeNull();
		expect(summary.durationMs).toBeNull();
		expect(summary.createdAt).toEqual(now);
		expect(summary.costUsd).toBe(0);
	});

	test("re-costs stored jobs at new rates", () => {
		const { jobs } = summarizeRun(
			run(),
			{ jobs: [job()], title: null },
			[],
			now,
		);
		expect(jobs[0]?.costUsd).toBe(0);
		const recosted = recostJobs(jobs, [{ label: "ubuntu", rate: 0.5 }]);
		expect(recosted.costUsd).toBe(1);
		expect(recosted.jobs[0]?.costUsd).toBe(1);
	});
});

describe("buildPipelineTrace", () => {
	const finished = {
		...summarizeRun(
			run({ status: "failure" }),
			{
				jobs: [
					job({
						status: "failure",
						steps: [
							{
								finishedAt: "2026-10-01T10:01:30.000Z",
								name: "Test",
								startedAt: "2026-10-01T10:01:00.000Z",
								status: "failure",
							},
						],
					}),
					job({ name: "never", startedAt: null, finishedAt: null }),
				],
				title: null,
			},
			defaultRates("github"),
			new Date(),
		),
		externalId: "42",
		pipelineToken: pipelineSpanToken("secret", "svc-1"),
		provider: "github" as const,
		repositoryId: "repo-1",
		serviceId: "svc-1",
	};

	test("builds a run, job and step span tree the ingest accepts", () => {
		const body = buildPipelineTrace(finished);
		expect(body).not.toBeNull();
		const [resource] = parseOtlpTraces(body);
		expect(resource?.attributes).toMatchObject({
			"homerun.pipeline": pipelineSpanToken("secret", "svc-1"),
			"homerun.service.id": "svc-1",
			"service.name": "github-actions",
		});
		const spans = resource?.spans ?? [];
		expect(spans.map((span) => span.name)).toEqual(["CI", "build", "Test"]);
		const [root, jobSpan, step] = spans;
		expect(root?.parentSpanId).toBeNull();
		expect(jobSpan?.parentSpanId).toBe(root?.spanId ?? "");
		expect(step?.parentSpanId).toBe(jobSpan?.spanId ?? "");
		expect(root?.statusCode).toBe(2);
		expect(root?.traceId).toBe(pipelineTraceId(finished));
		expect(root?.durationMs).toBe(150_000);
		expect(root?.attributes["homerun.pipeline.cost_usd"]).toBeCloseTo(0.012, 6);
		expect(
			spanOwner(
				resource?.attributes ?? {},
				[{ id: "svc-1", slug: "app", tracesEnabled: false }],
				(id, value) => validPipelineSpanToken(value, "secret", id),
			),
		).toEqual({ serviceId: "svc-1", serviceName: "github-actions" });
	});

	test("is stable per attempt and skips unfinished runs", () => {
		expect(buildPipelineTrace(finished)).toEqual(buildPipelineTrace(finished));
		expect(pipelineTraceId({ ...finished, attempt: 2 })).not.toBe(
			pipelineTraceId(finished),
		);
		expect(
			pipelineTraceId({
				...finished,
				finishedAt: new Date("2026-10-02T00:00:00Z"),
				provider: "gitlab",
			}),
		).not.toBe(pipelineTraceId({ ...finished, provider: "gitlab" }));
		expect(buildPipelineTrace({ ...finished, finishedAt: null })).toBeNull();
	});
});
