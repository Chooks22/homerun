import { config } from "#lib/config.js";
import { BackupRunDTO } from "#lib/dto/backup-run-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { NotificationChannelService } from "../../notification-channel.service.ts";
import { backupMessage } from "../../notification-messages.ts";
import { S3BackupService } from "../../s3-backup.service.ts";
import { backupJobPayload } from "../payloads.ts";
import type { WorkerJob } from "./types.ts";

const logger = new Logger("Backup");

/**
 * Loads the volume a backup or restore job targets.
 *
 * @throws When the volume was deleted after the job was queued.
 */
export async function jobVolume(
	volumeId: string,
	action: string,
): Promise<StorageVolumeDTO> {
	const volume = await StorageVolumeDTO.get(volumeId);
	if (!volume) {
		throw new Error(`The volume was deleted before its ${action} ran.`);
	}
	return volume;
}

/**
 * Records a Go-executed backup or restore's outcome on the `backup_run` row
 * its prepare step opened (the run id travels in the job's spec), returning
 * the job result.
 *
 * @throws The executor's error, after recording it on the run.
 */
export async function finishRun(
	job: JobDTO,
	result: Record<string, unknown> | null,
	error: string | null,
	fallback: string,
): Promise<{ key: string | null; sizeBytes: number | null }> {
	const runId = job.decryptSpec()?.runId;
	const run = typeof runId === "string" ? await BackupRunDTO.get(runId) : null;
	if (error || !result) {
		const message = error ?? fallback;
		await run?.finish({ error: message, success: false });
		logger.error(`${job.type} failed: job=${job.id} ${message}`);
		throw new Error(message);
	}
	const key = typeof result.key === "string" ? result.key : null;
	const sizeBytes =
		typeof result.sizeBytes === "number" ? result.sizeBytes : null;
	await run?.finish({
		key: key ?? undefined,
		sizeBytes: sizeBytes ?? undefined,
		success: true,
	});
	logger.info(`${job.type} done: job=${job.id} key=${key} bytes=${sizeBytes}`);
	return { key, sizeBytes };
}

/**
 * Opens a `backup_run` row, then builds the spec with it; a spec that can't
 * be built still closes the run as failed before the error propagates, so the
 * history shows every attempt.
 */
export async function withRun(
	run: BackupRunDTO,
	build: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	try {
		return { ...(await build()), runId: run.toJSON().id };
	} catch (err) {
		await run.finish({
			error: err instanceof Error ? err.message : String(err),
			success: false,
		});
		throw err;
	}
}

/**
 * Sends a backup's outcome to the notification channels, skipping a failure
 * the queue is about to retry; a scheduled backup's is grouped with the rest
 * of its run.
 */
function notifyBackup(
	job: JobDTO,
	volume: StorageVolumeDTO | null,
	scheduled: boolean,
	outcome: { error: string } | { key: string | null; sizeBytes: number | null },
): void {
	const ok = !("error" in outcome);
	if (!volume || (!ok && job.attempts < job.maxAttempts)) {
		return;
	}
	NotificationChannelService.notify(
		backupMessage(
			{
				attempts: job.attempts,
				error: ok ? null : outcome.error,
				key: ok ? outcome.key : null,
				ok,
				origin: config.auth.origin ?? null,
				scheduled,
				sizeBytes: ok ? outcome.sizeBytes : null,
				volume: { id: volume.id, name: volume.name },
			},
			new Date().toISOString(),
		),
		{ scheduled },
	);
}

/**
 * Deletes the volume's archives past its destination's `backupKeep` after a
 * successful backup, noting what went in the job's log. A failure is logged as a warning
 * and never fails the backup that just succeeded.
 */
async function pruneOldBackups(
	job: JobDTO,
	volume: StorageVolumeDTO | null,
	key: string | null,
): Promise<void> {
	if (!(volume && key)) {
		return;
	}
	try {
		const deleted = await S3BackupService.pruneBackups(volume, key);
		if (deleted.length > 0) {
			await JobDTO.appendLog(
				job.id,
				`Deleted ${deleted.length} older backups past the destination's limit: ${deleted.join(", ")}`,
			);
			logger.info(
				`Old backups deleted: volume=${volume.id} deleted=${deleted.length}`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await JobDTO.appendLog(job.id, `Couldn't delete older backups: ${message}`);
		logger.warn(`Deleting old backups failed: volume=${volume.id} ${message}`);
	}
}

export const backupWorkerJob: WorkerJob | null = {
	async finalize(job, result, error) {
		const { scheduled, volumeId } = backupJobPayload.parse(job.payload);
		const volume = await StorageVolumeDTO.get(volumeId);
		await volume?.update({ backupLastRunAt: new Date() });
		try {
			const done = await finishRun(job, result, error, "Backup failed.");
			notifyBackup(job, volume, scheduled, done);
			await pruneOldBackups(job, volume, done.key);
			return done;
		} catch (err) {
			notifyBackup(job, volume, scheduled, {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	},
	async prepare(job) {
		const { volumeId } = backupJobPayload.parse(job.payload);
		const volume = await jobVolume(volumeId, "backup");
		const run = await BackupRunDTO.create(volume.id, { jobId: job.id });
		try {
			return await withRun(run, () => S3BackupService.backupSpec(volume));
		} catch (err) {
			await volume.update({ backupLastRunAt: new Date() });
			throw err;
		}
	},
};
