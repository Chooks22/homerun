import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { restoreVolumeBackup, restoredVolumeNames } = await import(
	"../../../src/lib/services/backup/volume-restore"
);
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { StorageVolumeDTO } = await import(
	"../../../src/lib/dto/storage-volume-dto"
);
const { restoreBackupFormSchema } = await import(
	"../../../src/lib/server/validation/volume-restore"
);

const restorers: { mockRestore: () => void }[] = [];

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

function track<T extends { mockRestore: () => void }>(spy: T): T {
	restorers.push(spy);
	return spy;
}

const ROW = {
	backupEnabled: true,
	backupPrefix: "pfx",
	backupPreCommand: null,
	backupPreCommandServiceId: null,
	backupSchedule: "0 3 * * *",
	backupStopServices: true,
	id: "vol-1",
	kind: "volume",
	name: "db-data",
	s3DestinationId: "dest-1",
	userId: "u1",
};

function volume(overrides: Partial<typeof ROW> = {}) {
	const row = { ...ROW, ...overrides };
	return { id: row.id, name: row.name, toJSON: () => row } as never;
}

const svc = { id: "svc-1", name: "gitea" } as never;

function queue() {
	let next = 0;
	return track(
		spyOn(QueueService, "enqueue").mockImplementation(
			async () => ({ id: `job-${++next}` }) as never,
		),
	);
}

describe("restoredVolumeNames", () => {
	test("stamps the name with the date and derives a Docker volume from it", () => {
		expect(
			restoredVolumeNames("DB data", new Date("2026-09-28T14:05:09Z")),
		).toEqual({
			name: "DB data-restored-20260928-1405",
			source: "homerun-db-data-restored-20260928-1405",
		});
	});
});

describe("restoreVolumeBackup", () => {
	const base = {
		key: "db-data-1.tar.gz",
		options: { stopServices: true, wipe: false },
		svc,
		userId: "u1",
	};

	test("replace queues just the restore", async () => {
		const enqueue = queue();
		const message = await restoreVolumeBackup({
			...base,
			mode: "replace",
			volume: volume(),
		});
		expect(enqueue.mock.calls.map(([input]) => input.type)).toEqual([
			"backup_restore",
		]);
		expect(message).toContain("Restoring db-data-1.tar.gz into db-data");
	});

	test("backupFirst holds the restore until a backup of the current data succeeded", async () => {
		const enqueue = queue();
		await restoreVolumeBackup({
			...base,
			mode: "backupFirst",
			volume: volume(),
		});
		const [[backup], [restore]] = enqueue.mock.calls;
		expect([backup?.type, restore?.type, restore?.dependsOnJobId]).toEqual([
			"backup",
			"backup_restore",
			"job-1",
		]);
	});

	test("revision restores into a new volume with the same backup settings and redeploys once it's done", async () => {
		const enqueue = queue();
		const updated: unknown[] = [];
		const created = track(
			spyOn(StorageVolumeDTO, "create").mockImplementation(
				async (input) =>
					({
						id: "vol-2",
						name: input.name,
						toJSON: () => ({ ...ROW, ...input, id: "vol-2" }),
						update: async (patch: unknown) => {
							updated.push(patch);
						},
					}) as never,
			),
		);
		const deploy = track(
			spyOn(DeploymentService, "enqueueDeploy").mockResolvedValue({
				deploymentId: "d1",
				jobId: "job-9",
			}),
		);

		await restoreVolumeBackup({ ...base, mode: "revision", volume: volume() });

		expect(created.mock.calls[0]?.[0]).toMatchObject({
			kind: "volume",
			userId: "u1",
		});
		expect(updated[0]).toMatchObject({
			backupSchedule: "0 3 * * *",
			s3DestinationId: "dest-1",
		});
		expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
			payload: { stopServices: false, volumeId: "vol-2", wipe: false },
			type: "backup_restore",
		});
		expect(deploy.mock.calls[0]?.[0]).toMatchObject({
			dependsOnJobId: "job-1",
			mountSwap: { from: "vol-1", to: "vol-2" },
		});
	});

	test("revision refuses a host path", async () => {
		queue();
		await expect(
			restoreVolumeBackup({
				...base,
				mode: "revision",
				volume: volume({ kind: "bind" }),
			}),
		).rejects.toThrow("Docker volume");
	});
});

describe("restoreBackupFormSchema", () => {
	test("reads the mode and the checkboxes", () => {
		expect(
			restoreBackupFormSchema.parse({
				confirm: " db-data ",
				key: "k",
				mode: "revision",
				stopServices: "on",
				volumeId: "v",
			}),
		).toEqual({
			confirm: "db-data",
			key: "k",
			mode: "revision",
			stopServices: true,
			volumeId: "v",
			wipe: false,
		});
		expect(
			restoreBackupFormSchema.safeParse({
				confirm: "x",
				key: "k",
				mode: "nope",
				volumeId: "v",
			}).success,
		).toBe(false);
	});
});
