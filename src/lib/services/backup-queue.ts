import type { BackupRunDTO } from "#lib/dto/backup-run-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import type { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { closeCancelledDeploys } from "./queue/cancelled-deploys.ts";
import { QueueService } from "./queue.service.ts";
import type { RestoreOptions } from "./s3-backup.service.ts";

/** Enqueues a backup job for `volume`, deduped and lock-scoped per volume so a second backup can't be queued (or run) while one is already pending; `scheduled` marks one fired by the backup scheduler, whose outcome notification is grouped with the rest of that run. */
export function enqueueVolumeBackup(
	volume: StorageVolumeDTO,
	scheduled = false,
): Promise<JobDTO> {
	return QueueService.enqueue({
		dedupeKey: `backup:${volume.id}`,
		lockKey: `volume:${volume.id}`,
		maxAttempts: 2,
		payload: { scheduled, userId: volume.userId, volumeId: volume.id },
		title: `Back up ${volume.name}`,
		type: "backup",
		userId: volume.userId,
	});
}

/** Enqueues a restore of backup `key` into `volume`, sharing the per-volume lock with backups so a restore never runs while the same volume is being tarred, and never retried; `dependsOnJobId` holds it until that job (a backup of the current data) succeeds, and cancels it when that one fails. */
export function enqueueVolumeRestore(
	volume: StorageVolumeDTO,
	key: string,
	options: RestoreOptions,
	dependsOnJobId: string | null = null,
): Promise<JobDTO> {
	return QueueService.enqueue({
		dedupeKey: `restore:${volume.id}`,
		dependsOnJobId,
		lockKey: `volume:${volume.id}`,
		maxAttempts: 1,
		payload: {
			key,
			stopServices: options.stopServices,
			userId: volume.userId,
			volumeId: volume.id,
			wipe: options.wipe,
		},
		title: `Restore ${volume.name}`,
		type: "backup_restore",
		userId: volume.userId,
	});
}

/**
 * Cancels a backup or restore run: its job, when still queued or running
 * (the Go worker stops it at its next heartbeat, aborting the upload and
 * starting any services it stopped again), and the run itself, closed as
 * failed with `Cancelled by <who>`. A run whose job already ended but that
 * still shows as running (its outcome was never recorded) is just closed.
 *
 * @returns False when the run had already finished.
 */
export async function cancelBackupRun(
	run: BackupRunDTO,
	by: string,
): Promise<boolean> {
	const row = run.toJSON();
	if (row.success !== null) {
		return false;
	}
	const reason = `Cancelled by ${by}.`;
	if (row.jobId) {
		await closeCancelledDeploys(await JobDTO.cancel(row.jobId, reason), reason);
	}
	await run.finish({ error: reason, success: false });
	return true;
}

/** Enqueues a cleanup of every volume's archives past its destination's `backupKeep`, deduped so a second click while one is pending does nothing, and never retried. */
export function enqueueBackupPrune(userId: string): Promise<JobDTO> {
	return QueueService.enqueue({
		dedupeKey: "backup_prune",
		lockKey: "backup_prune",
		maxAttempts: 1,
		payload: { userId },
		title: "Clean up old backups",
		type: "backup_prune",
		userId,
	});
}
