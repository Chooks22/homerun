import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { rcloneRemote } = await import(
	"../../../src/lib/services/backup/rclone"
);
const { parseResticKey } = await import(
	"../../../src/lib/services/backup/restic"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { S3DestinationDTO } = await import(
	"../../../src/lib/dto/s3-destination-dto"
);
const { S3BackupService, backupKeyPattern } = await import(
	"../../../src/lib/services/s3-backup.service"
);

const restorers: { mockRestore: () => void }[] = [];

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

const REMOTE = rcloneRemote({
	host: "nas.local:2222",
	path: "backups",
	secret: "hunter2",
	type: "sftp",
	username: "bob",
});

let destinationKeep: number | null = null;

function volume(backupKeep: number | null) {
	destinationKeep = backupKeep;
	return {
		backupPrefix: null,
		id: "vol-1",
		name: "db",
		s3DestinationId: "dest-1",
	} as never;
}

function takenOn(name: string): string {
	const date = name.match(/(\d{4}-\d{2}-\d{2})T/)?.[1];
	return `${date}T03:00:00Z`;
}

function remoteWith(names: string[], snapshotDays: number[] = []) {
	restorers.push(
		spyOn(S3DestinationDTO, "get").mockImplementation(
			async () =>
				({
					accessKeyId: "bob",
					backupKeep: destinationKeep,
					bucket: "backups",
					decryptSecretAccessKey: () => "hunter2",
					endpoint: "nas.local:2222",
					resticPassword: async () => "restic-password",
					type: "sftp",
				}) as never,
		),
		spyOn(S3BackupService, "targetOf").mockReturnValue({ remote: REMOTE }),
	);
	const listing = JSON.stringify(
		names.map((Name) => ({ ModTime: takenOn(Name), Name, Size: 1 })),
	);
	const snapshots = JSON.stringify(
		snapshotDays.map((n) => ({
			id: `snap${n}`,
			time: takenOn(day(n)).replace("03:00", "04:00"),
		})),
	);
	const run = spyOn(DockerService, "runOneOff").mockImplementation(
		async ({ cmd }) => ({
			exitCode: 0,
			stderr: Buffer.from(""),
			stdout: Buffer.from(
				cmd?.[0] === "lsjson"
					? listing
					: cmd?.[0] === "snapshots"
						? snapshots
						: "",
			),
			timedOut: false,
		}),
	);
	restorers.push(run);
	return run;
}

const day = (n: number) =>
	`db-2026-10-${String(n).padStart(2, "0")}T03-00-00-000Z.tar.gz`;

describe("parseResticKey", () => {
	test("finds the repository's volume and the snapshot in a key", () => {
		expect(parseResticKey("restic:vol-1:0a1b2c")).toEqual({
			snapshot: "0a1b2c",
			volumeId: "vol-1",
		});
	});

	test("a legacy archive's key isn't a snapshot", () => {
		expect(parseResticKey("db-2026-10-01T03-00-00-000Z.tar.gz")).toBeNull();
	});
});

describe("backupKeyPattern", () => {
	test("matches only the volume's own timestamped archives", () => {
		const pattern = backupKeyPattern("db-");
		expect(pattern.test(day(1))).toBe(true);
		expect(pattern.test("db-data-2026-10-01T03-00-00-000Z.tar.gz")).toBe(false);
		expect(pattern.test(`${day(1)}.partial`)).toBe(false);
	});

	test("escapes a name with regex characters", () => {
		const pattern = backupKeyPattern("data (PR #2)-");
		expect(pattern.test("data (PR #2)-2026-10-01T03-00-00-000Z.tar.gz")).toBe(
			true,
		);
		expect(pattern.test("data PR #2-2026-10-01T03-00-00-000Z.tar.gz")).toBe(
			false,
		);
	});
});

describe("S3BackupService.pruneBackups", () => {
	test("deletes everything past the newest N, never another volume's", async () => {
		const run = remoteWith([
			day(1),
			day(4),
			day(2),
			day(3),
			"db-data-2026-10-01T03-00-00-000Z.tar.gz",
		]);

		const deleted = await S3BackupService.pruneBackups(volume(2), day(4));

		expect(deleted).toEqual([day(2), day(1)]);
		const deletes = run.mock.calls
			.map(([options]) => options.cmd)
			.filter((cmd) => cmd?.[0] === "deletefile");
		expect(deletes).toEqual([
			["deletefile", `dest:backups/${day(2)}`],
			["deletefile", `dest:backups/${day(1)}`],
		]);
	});

	test("cleans up on demand without a new archive", async () => {
		remoteWith([day(1), day(2), day(3)]);

		expect(await S3BackupService.pruneBackups(volume(1))).toEqual([
			day(2),
			day(1),
		]);
	});

	test("counts restic snapshots toward the limit and only deletes legacy archives", async () => {
		const run = remoteWith([day(1), day(2), day(3)], [4, 5]);

		const deleted = await S3BackupService.pruneBackups(
			volume(3),
			"restic:vol-1:snap5",
		);

		expect(deleted).toEqual([day(2), day(1)]);
		const snapshotsCall = run.mock.calls.find(
			([options]) => options.cmd?.[0] === "snapshots",
		)?.[0];
		expect(snapshotsCall?.envVars).toMatchObject({
			RESTIC_PASSWORD: "restic-password",
			RESTIC_REPOSITORY: "rclone:dest:backups/restic/vol-1",
		});
		expect(snapshotsCall?.imageMounts).toEqual([
			{ image: "rclone/rclone:1.75.1", target: "/opt/rclone" },
		]);
	});

	test("keeps everything without a limit", async () => {
		const run = remoteWith([day(1), day(2)]);

		expect(await S3BackupService.pruneBackups(volume(null), day(2))).toEqual(
			[],
		);
		expect(run).not.toHaveBeenCalled();
	});

	test("refuses when the new archive isn't listed", async () => {
		const run = remoteWith([day(1), day(2), day(3)]);

		await expect(
			S3BackupService.pruneBackups(volume(1), day(4)),
		).rejects.toThrow("isn't listed");
		expect(
			run.mock.calls.some(([options]) => options.cmd?.[0] === "deletefile"),
		).toBe(false);
	});
});
