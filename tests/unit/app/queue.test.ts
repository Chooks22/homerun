import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";
import type { CancelledJob } from "#lib/dto/job-dto.js";
import { restoreStubs, stub } from "../support/stub";

interface FakeJob {
	attempts: number;
	defer: ReturnType<typeof mock>;
	executorError: string | null;
	executorResult: Record<string, unknown> | null;
	handOff: ReturnType<typeof mock>;
	id: string;
	markFailed: ReturnType<typeof mock>;
	markSucceeded: ReturnType<typeof mock>;
	maxAttempts: number;
	scheduleRetry: ReturnType<typeof mock>;
	title: string;
	type: string;
}

function fakeJob(overrides: Partial<FakeJob> = {}): FakeJob {
	return {
		attempts: 1,
		defer: mock(async () => undefined),
		executorError: null,
		executorResult: null,
		handOff: mock(async () => undefined),
		id: "job-1",
		markFailed: mock(async () => undefined),
		markSucceeded: mock(async () => undefined),
		maxAttempts: 1,
		scheduleRetry: mock(async () => undefined),
		title: "Deploy web",
		type: "deploy",
		...overrides,
	};
}

mock.module("$app/env", () => ({ building: false, dev: false }));

const cancelDependents = mock(
	async (_id: string, _reason: string) => [] as CancelledJob[],
);
const findQueued = mock(async (_type: string, _key: string) => null as unknown);
const create = mock(async (_input: unknown) => null as unknown);
const get = mock(async (_id: string) => null as unknown);
const requeueOrphaned = mock(async (_live?: string[]) => 0);
const claimNext = mock(async () => null as unknown);
const claimFinalize = mock(async () => null as unknown);
const listStalledExecutions = mock(async (_since: Date) => [] as unknown[]);
const stampWorkerVersion = mock(async (_id: string, _version: string) => {});

const handler = mock(async (_entry: unknown) => ({ ok: true }) as unknown);

mock.module("../../../src/lib/services/queue/handlers", () => ({
	jobHandlers: { backup: handler, deploy: handler, docker_cleanup: handler },
}));

const prepare = mock(
	async (_entry: unknown) => ({ image: "nginx" }) as Record<string, unknown>,
);
const finalize = mock(
	async (_entry: unknown, _result: unknown, _error: unknown) =>
		({ finalized: true }) as Record<string, unknown> | null,
);

mock.module("../../../src/lib/services/queue/worker-jobs/index", () => ({
	workerJobs: { backup: { finalize, prepare }, deploy: null },
}));

const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { JobWorker } = await import("../../../src/lib/services/queue/worker");
const { JobDTO } = await import("../../../src/lib/dto/job-dto");
const { JobDeferredError } = await import(
	"../../../src/lib/services/queue/deferred"
);

type EnqueuedJob = Awaited<ReturnType<typeof QueueService.enqueue>>;

function fakeEnqueuedJob(overrides: Partial<FakeJob> = {}): EnqueuedJob {
	return fakeJob(overrides) as unknown as EnqueuedJob;
}

const baseInput = {
	payload: { serviceId: "svc-1" },
	title: "Deploy web",
	type: "deploy" as const,
	userId: "user-1",
};

beforeEach(() => {
	for (const [key, fn] of Object.entries({
		cancelDependents,
		claimFinalize,
		claimNext,
		create,
		findQueued,
		get,
		listStalledExecutions,
		requeueOrphaned,
		stampWorkerVersion,
	})) {
		stub(JobDTO, key, fn);
	}

	for (const m of [
		cancelDependents,
		findQueued,
		create,
		get,
		requeueOrphaned,
		claimNext,
		claimFinalize,
		listStalledExecutions,
		stampWorkerVersion,
		handler,
		prepare,
		finalize,
	]) {
		m.mockClear();
	}
});

afterEach(() => restoreStubs());

describe("QueueService.enqueue", () => {
	test("coalesces into an already-queued job with the same dedupe key", async () => {
		const existing = fakeEnqueuedJob({ id: "already-queued" });
		findQueued.mockResolvedValueOnce(existing);

		const result = await QueueService.enqueue({
			...baseInput,
			dedupeKey: "deploy:svc-1",
		});

		expect(result).toBe(existing);
		expect(create).not.toHaveBeenCalled();
	});

	test("creates a new job when nothing is queued for that key", async () => {
		const created = fakeEnqueuedJob({ id: "fresh" });
		findQueued.mockResolvedValueOnce(null);
		create.mockResolvedValueOnce(created);

		const result = await QueueService.enqueue({
			...baseInput,
			dedupeKey: "deploy:svc-1",
		});

		expect(result).toBe(created);
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("re-reads the winner when the unique index rejects a racing insert", async () => {
		const winner = fakeEnqueuedJob({ id: "winner" });
		findQueued.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
		create.mockResolvedValueOnce(null);

		const result = await QueueService.enqueue({
			...baseInput,
			dedupeKey: "deploy:svc-1",
		});

		expect(result).toBe(winner);
		expect(findQueued).toHaveBeenCalledTimes(2);
	});

	test("never coalesces a job that has no dedupe key", async () => {
		const created = fakeEnqueuedJob();
		create.mockResolvedValueOnce(created);

		await QueueService.enqueue(baseInput);

		expect(findQueued).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe("QueueService.wait", () => {
	test("returns as soon as the job succeeded", async () => {
		get.mockResolvedValueOnce({ ...fakeJob(), status: "succeeded" });
		const finished = await QueueService.wait("job-1");
		expect(finished.status).toBe("succeeded");
	});

	test("returns a failed job rather than hanging or throwing", async () => {
		get.mockResolvedValueOnce({
			...fakeJob(),
			error: "boom",
			status: "failed",
		});
		const finished = await QueueService.wait("job-1");
		expect(finished.status).toBe("failed");
		expect(finished.error).toBe("boom");
	});

	test("returns a cancelled job too", async () => {
		get.mockResolvedValueOnce({ ...fakeJob(), status: "cancelled" });
		const finished = await QueueService.wait("job-1");
		expect(finished.status).toBe("cancelled");
	});
});

describe("JobWorker.runJob", () => {
	test("records the handler's own result on success", async () => {
		const entry = fakeJob();
		handler.mockResolvedValueOnce({ containerId: "abc" });

		await JobWorker.runJob(entry as never);

		expect(entry.markSucceeded).toHaveBeenCalledWith({ containerId: "abc" });
		expect(entry.markFailed).not.toHaveBeenCalled();
	});

	test("retries with backoff while attempts are left, without failing the job", async () => {
		const entry = fakeJob({ attempts: 1, maxAttempts: 3 });
		handler.mockRejectedValueOnce(new Error("s3 timed out"));

		const before = Date.now();
		await JobWorker.runJob(entry as never);

		expect(entry.markFailed).not.toHaveBeenCalled();
		expect(entry.scheduleRetry).toHaveBeenCalledTimes(1);
		const [message, runAt] = entry.scheduleRetry.mock.calls[0] as [
			string,
			Date,
		];
		expect(message).toBe("s3 timed out");
		expect((runAt as Date).getTime()).toBeGreaterThan(before);
		expect(cancelDependents).not.toHaveBeenCalled();
	});

	test("fails permanently on the last attempt and cancels everything downstream", async () => {
		const entry = fakeJob({ attempts: 2, maxAttempts: 2, id: "last" });
		handler.mockRejectedValueOnce(new Error("image not found"));

		await JobWorker.runJob(entry as never);

		expect(entry.scheduleRetry).not.toHaveBeenCalled();
		expect(entry.markFailed).toHaveBeenCalledWith("image not found");
		expect(cancelDependents).toHaveBeenCalledTimes(1);
		expect(cancelDependents.mock.calls[0]?.[0]).toBe("last");
	});
});

describe("JobWorker, Go-executed job types", () => {
	test("runs prepare and hands the spec to the Go worker instead of a handler", async () => {
		const entry = fakeJob({ type: "backup" });

		await JobWorker.runJob(entry as never);

		expect(prepare).toHaveBeenCalledWith(entry);
		expect(entry.handOff).toHaveBeenCalledWith({ image: "nginx" });
		expect(handler).not.toHaveBeenCalled();
		expect(entry.markSucceeded).not.toHaveBeenCalled();
	});

	test("a job type without a worker module still runs in-process", async () => {
		const entry = fakeJob({ type: "deploy" });

		await JobWorker.runJob(entry as never);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(entry.handOff).not.toHaveBeenCalled();
		expect(entry.markSucceeded).toHaveBeenCalledTimes(1);
	});

	test("a throwing prepare takes the normal retry path and never reaches the worker", async () => {
		const entry = fakeJob({ attempts: 1, maxAttempts: 2, type: "backup" });
		prepare.mockRejectedValueOnce(new Error("volume is gone"));

		await JobWorker.runJob(entry as never);

		expect(entry.handOff).not.toHaveBeenCalled();
		expect(entry.scheduleRetry.mock.calls[0]?.[0]).toBe("volume is gone");
	});

	test("a deferring prepare puts the job back in the queue without spending an attempt", async () => {
		const entry = fakeJob({ attempts: 1, maxAttempts: 1, type: "backup" });
		const runAt = new Date(Date.now() + 5000);
		prepare.mockRejectedValueOnce(
			new JobDeferredError("server full", "build-slot", runAt),
		);

		await JobWorker.runJob(entry as never);

		expect(entry.defer).toHaveBeenCalledWith(runAt, "build-slot");
		expect(entry.handOff).not.toHaveBeenCalled();
		expect(entry.scheduleRetry).not.toHaveBeenCalled();
		expect(entry.markFailed).not.toHaveBeenCalled();
	});

	test("finalize gets the executor's outcome and its result marks the job succeeded", async () => {
		const entry = fakeJob({
			executorResult: { key: "b.tar" },
			type: "backup",
		});

		await JobWorker.finalizeJob(entry as never);

		expect(finalize).toHaveBeenCalledWith(entry, { key: "b.tar" }, null);
		expect(entry.markSucceeded).toHaveBeenCalledWith({ finalized: true });
	});

	test("a throwing finalize retries while attempts are left", async () => {
		const entry = fakeJob({
			attempts: 1,
			executorError: "s3 timed out",
			maxAttempts: 2,
			type: "backup",
		});
		finalize.mockRejectedValueOnce(new Error("s3 timed out"));

		await JobWorker.finalizeJob(entry as never);

		expect(entry.markSucceeded).not.toHaveBeenCalled();
		expect(entry.scheduleRetry.mock.calls[0]?.[0]).toBe("s3 timed out");
	});

	test("a throwing finalize on the last attempt fails the job and its dependents", async () => {
		const entry = fakeJob({ id: "last-backup", type: "backup" });
		finalize.mockRejectedValueOnce(new Error("upload failed"));

		await JobWorker.finalizeJob(entry as never);

		expect(entry.markFailed).toHaveBeenCalledWith("upload failed");
		expect(cancelDependents.mock.calls[0]?.[0]).toBe("last-backup");
	});

	test("a finalize row for a type with no worker module fails instead of hanging", async () => {
		const entry = fakeJob({ type: "deploy" });

		await JobWorker.finalizeJob(entry as never);

		expect(entry.markFailed).toHaveBeenCalledTimes(1);
		expect(entry.markSucceeded).not.toHaveBeenCalled();
	});
});

describe("JobWorker tick", () => {
	test("retries a failed orphan recovery, then recovers once, finalizes executed jobs and claims new work", async () => {
		const executed = fakeJob({ id: "executed", type: "backup" });
		requeueOrphaned.mockRejectedValueOnce(new Error("duplicate key"));
		claimFinalize.mockResolvedValueOnce(executed).mockResolvedValueOnce(null);
		const tick = () =>
			(JobWorker as unknown as { tick: () => Promise<void> }).tick();

		await expect(tick()).rejects.toThrow("duplicate key");
		await tick();
		await tick();
		await Bun.sleep(0);

		expect(requeueOrphaned).toHaveBeenCalledTimes(2);
		expect(finalize).toHaveBeenCalledWith(executed, null, null);
		expect(executed.markSucceeded).toHaveBeenCalledTimes(1);
		expect(claimNext).toHaveBeenCalledTimes(2);
		expect(listStalledExecutions).toHaveBeenCalledTimes(1);
	});
});

describe("JobWorker hold and dispatch", () => {
	const tick = () =>
		(JobWorker as unknown as { tick: () => Promise<void> }).tick();

	test("a held worker claims nothing until released", async () => {
		JobWorker.hold();
		expect(JobWorker.held).toBe(true);
		await tick();
		expect(claimNext).not.toHaveBeenCalled();

		JobWorker.release();
		expect(JobWorker.held).toBe(false);
		await tick();
		expect(claimNext).toHaveBeenCalledTimes(1);
	});

	test("dispatches claimed jobs, stays busy while they run, and survives bookkeeping failures", async () => {
		let finish: (value: unknown) => void = () => undefined;
		handler.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const running = fakeJob({ id: "running" });
		const broken = fakeJob({
			id: "broken",
			markFailed: mock(async () => {
				throw new Error("db down");
			}),
		});
		handler.mockRejectedValueOnce(new Error("boom"));
		claimNext
			.mockResolvedValueOnce(running)
			.mockResolvedValueOnce(broken)
			.mockResolvedValueOnce(null);

		await tick();
		expect(JobWorker.busy).toBe(true);

		finish({ ok: true });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(running.markSucceeded).toHaveBeenCalledTimes(1);
		expect(broken.markFailed).toHaveBeenCalledTimes(1);
		expect(JobWorker.busy).toBe(false);
	});

	test("a finalize whose bookkeeping throws is logged, not left in flight", async () => {
		const executed = fakeJob({
			id: "executed-broken",
			markFailed: mock(async () => {
				throw new Error("db down");
			}),
			type: "backup",
		});
		finalize.mockRejectedValueOnce(new Error("upload failed"));
		claimFinalize.mockResolvedValueOnce(executed).mockResolvedValueOnce(null);

		await tick();
		await Bun.sleep(0);

		expect(executed.markFailed).toHaveBeenCalledTimes(1);
		expect(JobWorker.busy).toBe(false);
	});
});

describe("JobWorker orphan sweep", () => {
	const tick = () =>
		(JobWorker as unknown as { tick: () => Promise<void> }).tick();

	test("keeps sweeping every 30s, sparing the jobs still in flight", async () => {
		const start = Date.now() + 10 * 60_000;
		setSystemTime(new Date(start));
		try {
			let finish: (value: unknown) => void = () => undefined;
			handler.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			claimNext
				.mockResolvedValueOnce(fakeJob({ id: "in-flight" }))
				.mockResolvedValueOnce(null);
			requeueOrphaned.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

			await tick();
			await tick();
			expect(requeueOrphaned).toHaveBeenCalledTimes(1);

			setSystemTime(new Date(start + 31_000));
			await tick();
			expect(requeueOrphaned).toHaveBeenCalledTimes(2);
			expect(requeueOrphaned.mock.calls[1]?.[0]).toEqual(["in-flight"]);

			finish({ ok: true });
			await Bun.sleep(0);
			await Bun.sleep(0);
			setSystemTime(new Date(start + 62_000));
			await tick();
			expect(requeueOrphaned.mock.calls[2]?.[0]).toEqual([]);
		} finally {
			setSystemTime();
		}
	});
});
