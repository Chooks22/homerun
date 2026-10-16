import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { PipelineRunDTO } = await import(
	"../../../src/lib/dto/pipeline-run-dto"
);
const { StatusCheckService } = await import(
	"../../../src/lib/services/status-check.service"
);
const { TracingService } = await import(
	"../../../src/lib/services/tracing.service"
);
const { PipelineService } = await import(
	"../../../src/lib/services/pipeline.service"
);
const { formatRunDuration } = await import("../../../src/lib/pipelines/list");

type Svc = Parameters<typeof PipelineService.sync>[0];

const API = "https://api.github.test";

function run(id: number, status: string, conclusion: string | null) {
	return {
		conclusion,
		created_at: "2026-10-01T10:00:00Z",
		head_branch: "main",
		id,
		name: "CI",
		run_attempt: 1,
		status,
	};
}

const JOB = {
	completed_at: "2026-10-01T10:02:30Z",
	conclusion: "success",
	labels: ["ubuntu-latest"],
	name: "build",
	started_at: "2026-10-01T10:01:00Z",
	status: "completed",
	steps: [],
};

let kind = "github";
let updates: Record<string, unknown>[] = [];
let fetched: string[] = [];
let upserts: Record<string, unknown>[] = [];
let exported: unknown[] = [];
let marked: string[] = [];
let stored: { jobs: unknown[]; recost: unknown[] }[] = [];

function service(rates: unknown = null): Svc {
	return {
		buildSource: "git",
		gitUrl: "https://github.com/acme/api.git",
		id: "svc-1",
		toJSON: () => ({ pipelineRates: rates }),
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
		},
		userId: "user-1",
	} as unknown as Svc;
}

beforeEach(() => {
	kind = "github";
	updates = [];
	fetched = [];
	upserts = [];
	exported = [];
	marked = [];
	stored = [];
	stub(StatusCheckService, "targetFor", async () => ({
		api: API,
		kind,
		repo: "acme/api",
		token: "t",
	}));
	stub(globalThis, "fetch", async (input: string) => {
		fetched.push(input);
		if (input === `${API}/repos/acme/api/actions/runs?per_page=50`) {
			return Response.json({
				workflow_runs: [
					run(1, "completed", "success"),
					run(2, "completed", "success"),
					run(3, "in_progress", null),
				],
			});
		}
		if (input.includes("/jobs")) {
			return Response.json({ jobs: [JOB] });
		}
		return new Response("down", { status: 503 });
	});
	stub(PipelineRunDTO, "known", async () => {
		return new Map([["1", { attempt: 1, status: "success" }]]);
	});
	stub(PipelineRunDTO, "upsert", async (row: Record<string, unknown>) => {
		upserts.push(row);
	});
	stub(PipelineRunDTO, "listUnexported", async () =>
		upserts
			.filter((row) => row.finishedAt)
			.map((row) => ({
				markExported: async (traceId: string) => {
					marked.push(traceId);
				},
				toJSON: () => row,
			})),
	);
	stub(PipelineRunDTO, "listForService", async () =>
		stored.map((entry) => ({
			setCost: async (cost: number, jobs: unknown[]) => {
				entry.recost.push({ cost, jobs });
			},
			toJSON: () => ({ jobs: entry.jobs }),
		})),
	);
	stub(TracingService, "exportSpans", async (body: unknown) => {
		exported.push(body);
		return true;
	});
});

afterEach(restoreStubs);

describe("PipelineService.sync", () => {
	test("reads jobs only for new or unfinished runs and exports the finished ones", async () => {
		const result = await PipelineService.sync(service());

		expect(result).toEqual({ exported: 1, fetched: 3, updated: 2 });
		expect(fetched.filter((url) => url.includes("/jobs"))).toEqual([
			`${API}/repos/acme/api/actions/runs/2/jobs?per_page=100&filter=all`,
			`${API}/repos/acme/api/actions/runs/3/jobs?per_page=100&filter=all`,
		]);
		expect(upserts.map((row) => [row.externalId, row.status])).toEqual([
			["2", "success"],
			["3", "running"],
		]);
		expect(upserts[0]).toMatchObject({
			billableMinutes: 2,
			costUsd: 0.012,
			provider: "github",
			serviceId: "svc-1",
		});
		expect(exported).toHaveLength(1);
		expect(marked).toHaveLength(1);
		expect(updates.at(-1)).toMatchObject({ pipelinesError: null });
		expect(updates.at(-1)?.pipelinesSyncedAt).toBeInstanceOf(Date);
	});

	test("costs runs at the service's own rates", async () => {
		await PipelineService.sync(service([{ label: "ubuntu", rate: 1 }]));
		expect(upserts[0]?.costUsd).toBe(2);
	});

	test("records why a sync failed and rethrows", async () => {
		stub(globalThis, "fetch", async () => new Response("no", { status: 401 }));
		await expect(PipelineService.sync(service())).rejects.toThrow("HTTP 401");
		expect(String(updates.at(-1)?.pipelinesError)).toContain("HTTP 401");
	});
});

describe("PipelineService.clientFor", () => {
	test("refuses Bitbucket and image services", async () => {
		kind = "bitbucket";
		await expect(PipelineService.clientFor(service())).rejects.toThrow(
			"Bitbucket Pipelines isn't supported",
		);
		const image = service();
		Object.assign(image, { buildSource: "image" });
		await expect(PipelineService.clientFor(image)).rejects.toThrow(
			"Only services built from a git repo",
		);
	});
});

describe("PipelineService.saveSettings", () => {
	test("saves parsed rates and re-costs every stored run", async () => {
		stored = [
			{
				jobs: [
					{
						attempt: 1,
						billableMinutes: 3,
						costUsd: 0,
						labels: ["macos-14"],
						runner: null,
					},
				],
				recost: [],
			},
		];
		const svc = service();
		svc.toJSON = () =>
			({ pipelineRates: [{ label: "macos", rate: 0.5 }] }) as ReturnType<
				Svc["toJSON"]
			>;
		await PipelineService.saveSettings(svc, {
			enabled: true,
			rates: "macos = 0.5",
		});
		expect(updates[0]).toEqual({
			pipelineRates: [{ label: "macos", rate: 0.5 }],
			pipelinesEnabled: true,
		});
		expect(stored[0]?.recost).toEqual([
			{
				cost: 1.5,
				jobs: [
					{
						attempt: 1,
						billableMinutes: 3,
						costUsd: 1.5,
						labels: ["macos-14"],
						runner: null,
					},
				],
			},
		]);
	});

	test("blank rates go back to the defaults and a bad line throws", async () => {
		await PipelineService.saveSettings(service(), {
			enabled: false,
			rates: "  ",
		});
		expect(updates[0]).toEqual({
			pipelineRates: null,
			pipelinesEnabled: false,
			pipelinesError: null,
		});
		await expect(
			PipelineService.saveSettings(service(), {
				enabled: true,
				rates: "macos is pricey",
			}),
		).rejects.toThrow("Line 1");
	});
});

describe("PipelineService.overview", () => {
	const totals = {
		avgQueueMs: null,
		billableMinutes: 0,
		costUsd: 0,
		failed: 0,
		name: null,
		p50Ms: null,
		p95Ms: null,
		runs: 0,
		succeeded: 0,
	};

	test("sums the last 30 days and all time with the rates in force", async () => {
		const windows: (Date | null)[] = [];
		stub(PipelineRunDTO, "stats", async (_id: string, since: Date | null) => {
			windows.push(since);
			return { ...totals, runs: since ? 4 : 9 };
		});
		stub(PipelineRunDTO, "byWorkflow", async () => [
			{ ...totals, name: "CI", runs: 4 },
		]);
		const overview = await PipelineService.overview(
			service(),
			new Date("2026-10-31T00:00:00Z"),
		);
		expect(windows).toEqual([new Date("2026-10-01T00:00:00Z"), null]);
		expect(overview).toMatchObject({
			allTime: { runs: 9 },
			provider: "github",
			providerError: null,
			ratesCustom: false,
			window: { runs: 4 },
			workflows: [{ name: "CI" }],
		});
		expect(overview.rates[0]).toEqual({ label: "self-hosted", rate: 0 });
	});

	test("says why the repo's CI can't be read", async () => {
		kind = "bitbucket";
		stub(PipelineRunDTO, "stats", async () => totals);
		stub(PipelineRunDTO, "byWorkflow", async () => []);
		const overview = await PipelineService.overview(service());
		expect(overview.provider).toBeNull();
		expect(overview.providerError).toContain("Bitbucket");
		expect(overview.rates).toEqual([]);
	});
});

describe("formatRunDuration", () => {
	test("shows a dash until a run finishes", () => {
		expect(formatRunDuration(null)).toBe("—");
		expect(formatRunDuration(90_000)).toBe("1 min 30 s");
	});
});
