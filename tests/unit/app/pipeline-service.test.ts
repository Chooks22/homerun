import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { GitConnectionDTO } = await import(
	"../../../src/lib/dto/git-connection-dto"
);
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { PipelineRunDTO } = await import(
	"../../../src/lib/dto/pipeline-run-dto"
);
const { RepositoryDTO } = await import("../../../src/lib/dto/repository-dto");
const { GitProviderService } = await import(
	"../../../src/lib/services/git-provider.service"
);
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { TracingService } = await import(
	"../../../src/lib/services/tracing.service"
);
const { PipelineService } = await import(
	"../../../src/lib/services/pipeline.service"
);
const { pipelineSpanToken } = await import(
	"../../../src/lib/tracing/ingest-token"
);
const { formatRunDuration } = await import("../../../src/lib/pipelines/list");

type Repo = Parameters<typeof PipelineService.sync>[0];

const API = "https://api.github.com";

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

const totals = {
	avgQueueMs: null,
	billableMinutes: 0,
	costUsd: 0,
	failed: 0,
	name: null,
	p50Ms: null,
	p95Ms: null,
	repositoryId: null,
	runs: 0,
	succeeded: 0,
};

let kind = "github";
let connected = true;
let linkedServices: { id: string; name: string }[] = [];
let updates: Record<string, unknown>[] = [];
let linkedSets: string[][] = [];
let fetched: string[] = [];
let upserts: Record<string, unknown>[] = [];
let exported: { resourceSpans: { resource: { attributes: unknown[] } }[] }[] =
	[];
let marked: [string, string | null][] = [];
let enqueued: Record<string, unknown>[] = [];
let stored: { jobs: unknown[]; recost: unknown[] }[] = [];

function repository(rates: unknown = null, id = "repo-1"): Repo {
	return {
		fullName: "acme/api",
		id,
		linkedServices: async () => linkedServices,
		providerId: "gh",
		providerKind: kind,
		setLinkedServices: async (ids: string[]) => {
			linkedSets.push(ids);
		},
		toJSON: () => ({ defaultBranch: "main", pipelineRates: rates }),
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
		},
		userId: "user-1",
	} as unknown as Repo;
}

beforeEach(() => {
	kind = "github";
	connected = true;
	linkedServices = [{ id: "svc-1", name: "api" }];
	updates = [];
	linkedSets = [];
	fetched = [];
	upserts = [];
	exported = [];
	marked = [];
	enqueued = [];
	stored = [];
	stub(InstanceSettingsDTO, "get", async () => ({
		gitProviders: [
			{ baseUrl: null, enabled: true, id: "gh", kind, name: "GitHub" },
		],
	}));
	stub(GitConnectionDTO, "getForUserAndProvider", async () =>
		connected ? { id: "conn-1" } : null,
	);
	stub(GitProviderService, "accessToken", async () => "token");
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
				markExported: async (traceId: string, serviceId: string | null) => {
					marked.push([traceId, serviceId]);
				},
				toJSON: () => row,
			})),
	);
	stub(PipelineRunDTO, "listForRepository", async () =>
		stored.map((entry) => ({
			setCost: async (cost: number, jobs: unknown[]) => {
				entry.recost.push({ cost, jobs });
			},
			toJSON: () => ({ jobs: entry.jobs }),
		})),
	);
	stub(TracingService, "exportSpans", async (body: never) => {
		exported.push(body);
		return true;
	});
	stub(QueueService, "enqueue", async (input: Record<string, unknown>) => {
		enqueued.push(input);
		return { id: `job-${enqueued.length}` };
	});
});

afterEach(restoreStubs);

function resourceAttribute(index: number, key: string): unknown {
	const attributes = exported[index]?.resourceSpans[0]?.resource.attributes as {
		key: string;
		value: Record<string, unknown>;
	}[];
	const entry = attributes.find((attribute) => attribute.key === key);
	return entry ? Object.values(entry.value)[0] : undefined;
}

describe("PipelineService.sync", () => {
	test("reads jobs only for new or unfinished runs and files finished ones under the first linked service", async () => {
		const result = await PipelineService.sync(repository());

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
			repositoryId: "repo-1",
		});
		expect(marked).toHaveLength(1);
		expect(marked[0]?.[1]).toBe("svc-1");
		expect(resourceAttribute(0, "homerun.service.id")).toBe("svc-1");
		expect(resourceAttribute(0, "homerun.pipeline")).toBe(
			pipelineSpanToken(config.auth.secret, "svc-1"),
		);
		expect(updates.at(-1)).toMatchObject({ pipelinesError: null });
		expect(updates.at(-1)?.pipelinesSyncedAt).toBeInstanceOf(Date);
	});

	test("files the traces as Homerun's own when no service is linked", async () => {
		linkedServices = [];
		await PipelineService.sync(repository());
		expect(marked[0]?.[1]).toBeNull();
		expect(resourceAttribute(0, "homerun.service.id")).toBeUndefined();
		expect(resourceAttribute(0, "homerun.pipeline")).toBe(
			pipelineSpanToken(config.auth.secret, ""),
		);
	});

	test("costs runs at the repository's own rates and logs each step", async () => {
		const lines: string[] = [];
		await PipelineService.sync(
			repository([{ label: "ubuntu", rate: 1 }]),
			async (line) => {
				lines.push(line);
			},
		);
		expect(upserts[0]?.costUsd).toBe(2);
		expect(lines).toEqual([
			"Read 3 runs of acme/api.",
			"Stored 2 new or changed runs.",
			"Exported 1 finished runs as traces.",
		]);
	});

	test("records why a sync failed and rethrows", async () => {
		stub(globalThis, "fetch", async () => new Response("no", { status: 401 }));
		await expect(PipelineService.sync(repository())).rejects.toThrow(
			"HTTP 401",
		);
		expect(String(updates.at(-1)?.pipelinesError)).toContain("HTTP 401");
	});
});

describe("PipelineService.clientFor", () => {
	test("refuses Bitbucket, a missing connection and a removed provider", async () => {
		kind = "bitbucket";
		await expect(PipelineService.clientFor(repository())).rejects.toThrow(
			"Bitbucket Pipelines isn't supported",
		);
		kind = "github";
		connected = false;
		await expect(PipelineService.clientFor(repository())).rejects.toThrow(
			"isn't connected to GitHub any more",
		);
		stub(InstanceSettingsDTO, "get", async () => ({ gitProviders: [] }));
		await expect(PipelineService.clientFor(repository())).rejects.toThrow(
			"removed or turned off",
		);
	});
});

describe("PipelineService.watch", () => {
	test("creates the repository, links the services building from it and queues a sync", async () => {
		const created: Record<string, unknown>[] = [];
		stub(RepositoryDTO, "getByPath", async () => null);
		stub(RepositoryDTO, "create", async (input: Record<string, unknown>) => {
			created.push(input);
			return repository();
		});
		stub(RepositoryDTO, "servicesBuildingFrom", async () => ["svc-9"]);
		await PipelineService.watch({
			defaultBranch: "main",
			fullName: "acme/api",
			providerId: "gh",
			userId: "user-1",
		});
		expect(created).toEqual([
			{
				defaultBranch: "main",
				fullName: "acme/api",
				providerId: "gh",
				providerKind: "github",
				userId: "user-1",
				webUrl: "https://github.com/acme/api",
			},
		]);
		expect(linkedSets).toEqual([["svc-9"]]);
		expect(enqueued).toEqual([
			{
				dedupeKey: "pipeline_sync:repo-1",
				lockKey: "pipeline_sync:repo-1",
				maxAttempts: 1,
				payload: { repositoryId: "repo-1" },
				title: "Sync CI runs of acme/api",
				type: "pipeline_sync",
				userId: "user-1",
			},
		]);
	});

	test("returns a repository already watched as is", async () => {
		const existing = repository();
		stub(RepositoryDTO, "getByPath", async () => existing);
		expect(
			await PipelineService.watch({
				defaultBranch: null,
				fullName: "acme/api",
				providerId: "gh",
				userId: "user-1",
			}),
		).toBe(existing);
		expect(enqueued).toEqual([]);
	});

	test("refuses a Bitbucket repository", async () => {
		kind = "bitbucket";
		stub(RepositoryDTO, "getByPath", async () => null);
		await expect(
			PipelineService.watch({
				defaultBranch: null,
				fullName: "acme/api",
				providerId: "gh",
				userId: "user-1",
			}),
		).rejects.toThrow("Bitbucket");
	});
});

describe("PipelineService.enqueueSyncAll", () => {
	test("queues one sync per repository with syncing on", async () => {
		stub(RepositoryDTO, "listPipelinesEnabled", async () => [
			repository(null, "repo-1"),
			repository(null, "repo-2"),
		]);
		expect(await PipelineService.enqueueSyncAll("user-1")).toEqual([
			"job-1",
			"job-2",
		]);
		expect(enqueued.map((entry) => entry.dedupeKey)).toEqual([
			"pipeline_sync:repo-1",
			"pipeline_sync:repo-2",
		]);
	});
});

describe("PipelineService.saveSettings", () => {
	test("saves parsed rates and linked services, then re-costs every stored run", async () => {
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
		const repo = repository();
		repo.toJSON = () =>
			({
				pipelineRates: [{ label: "macos", rate: 0.5 }],
			}) as ReturnType<Repo["toJSON"]>;
		await PipelineService.saveSettings(repo, {
			enabled: true,
			rates: "macos = 0.5",
			serviceIds: ["svc-1", "svc-2"],
		});
		expect(updates[0]).toEqual({
			pipelineRates: [{ label: "macos", rate: 0.5 }],
			pipelinesEnabled: true,
		});
		expect(linkedSets).toEqual([["svc-1", "svc-2"]]);
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
		await PipelineService.saveSettings(repository(), {
			enabled: false,
			rates: "  ",
			serviceIds: [],
		});
		expect(updates[0]).toEqual({
			pipelineRates: null,
			pipelinesEnabled: false,
			pipelinesError: null,
		});
		await expect(
			PipelineService.saveSettings(repository(), {
				enabled: true,
				rates: "macos is pricey",
				serviceIds: [],
			}),
		).rejects.toThrow("Line 1");
	});
});

describe("PipelineService.overview", () => {
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
			repository(),
			new Date("2026-10-31T00:00:00Z"),
		);
		expect(windows).toEqual([new Date("2026-10-01T00:00:00Z"), null]);
		expect(overview).toMatchObject({
			allTime: { runs: 9 },
			ratesCustom: false,
			window: { runs: 4 },
			workflows: [{ name: "CI" }],
		});
		expect(overview.rates[0]).toEqual({ label: "self-hosted", rate: 0 });
	});
});

describe("PipelineService.globalOverview", () => {
	test("lists every watched repository, busiest first, then by name", async () => {
		stub(PipelineRunDTO, "stats", async () => totals);
		stub(
			PipelineRunDTO,
			"byRepository",
			async () => new Map([["repo-b", { ...totals, runs: 3 }]]),
		);
		stub(RepositoryDTO, "list", async () => [
			{ id: "repo-c", toJSON: () => ({ fullName: "c/c", id: "repo-c" }) },
			{ id: "repo-a", toJSON: () => ({ fullName: "a/a", id: "repo-a" }) },
			{ id: "repo-b", toJSON: () => ({ fullName: "b/b", id: "repo-b" }) },
		]);
		stub(
			RepositoryDTO,
			"linkedServicesByRepository",
			async () => new Map([["repo-a", [{ id: "svc-1", name: "api" }]]]),
		);
		const overview = await PipelineService.globalOverview();
		expect(
			overview.repositories.map((row) => [
				row.repository.fullName,
				row.stats?.runs ?? 0,
				row.services.length,
			]),
		).toEqual([
			["b/b", 3, 0],
			["a/a", 0, 1],
			["c/c", 0, 0],
		]);
	});
});

describe("formatRunDuration", () => {
	test("shows a dash until a run finishes", () => {
		expect(formatRunDuration(null)).toBe("—");
		expect(formatRunDuration(90_000)).toBe("1 min 30 s");
	});
});
