import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { Logger } = await import("../../../src/lib/logger");
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { enqueueCleanup, queueCleanup } = await import(
	"../../../src/lib/services/docker-cleanup-queue"
);

const enqueued: Record<string, unknown>[] = [];
const logged: string[] = [];

beforeEach(() => {
	enqueued.length = 0;
	logged.length = 0;
	stub(QueueService, "enqueue", async (input: Record<string, unknown>) => {
		enqueued.push(input);
		return { id: `job-${enqueued.length}` };
	});
	stub(Logger.prototype, "info", (message: string) => {
		logged.push(message);
	});
});

afterEach(() => {
	restoreStubs();
});

describe("enqueueCleanup", () => {
	test("queues an exclusive, deduplicated prune job", async () => {
		await enqueueCleanup("pruneImages", true, "u1");
		expect(enqueued).toEqual([
			{
				dedupeKey: "docker-cleanup:pruneImages",
				exclusive: true,
				payload: { action: "pruneImages", all: true },
				priority: 10,
				title: "Prune images",
				type: "docker_cleanup",
				userId: "u1",
			},
		]);
	});
});

describe("queueCleanup", () => {
	test("answers at once with the queued job's id", async () => {
		expect(await queueCleanup("pruneVolumes", false, "u1")).toEqual({
			action: "pruneVolumes",
			jobId: "job-1",
			success: true,
		});
		expect(enqueued[0]).toMatchObject({
			payload: { action: "pruneVolumes", all: false },
			title: "Prune unused volumes",
		});
		expect(logged).toEqual(["pruneVolumes queued by user=u1 job=job-1"]);
	});
});
