import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import type { RestoreMode } from "#lib/restore-modes.js";
import { slugify } from "#lib/slug.js";
import { enqueueVolumeBackup, enqueueVolumeRestore } from "../backup-queue.ts";
import { DeploymentService } from "../deploy.service.ts";
import type { RestoreOptions } from "../s3-backup.service.ts";

const logger = new Logger("Backups");

export interface VolumeRestoreInput {
	key: string;
	mode: RestoreMode;
	options: RestoreOptions;
	svc: ServiceDTO;
	userId: string;
	volume: StorageVolumeDTO;
}

/** The name and Docker volume of the new volume a backup is restored into for a revision: `<name>-restored-<yyyymmdd-hhmm>`. */
export function restoredVolumeNames(
	name: string,
	at: Date,
): { name: string; source: string } {
	const stamp = at
		.toISOString()
		.slice(0, 16)
		.replace(/[-:]/g, "")
		.replace("T", "-");
	const restored = `${name}-restored-${stamp}`;
	return { name: restored, source: `homerun-${slugify(restored)}` };
}

/**
 * Restores backup `key` into a service's volume, one of three ways:
 * `replace` unpacks it over the current data; `backupFirst` backs the
 * current data up and only restores once that backup succeeded (cancelled
 * if it fails); `revision` leaves the current volume alone, restores into a
 * new Docker volume with the same backup settings, and queues a redeploy
 * that waits for the restore and then mounts the new volume in the old
 * one's place, so the result is a new revision and rolling back with its
 * config goes back to the old data.
 *
 * @returns A sentence saying what was queued.
 * @throws When `revision` is asked of a host-path volume, which can't be
 *   cloned into a new Docker volume.
 */
export async function restoreVolumeBackup(
	input: VolumeRestoreInput,
): Promise<string> {
	const { key, mode, options, svc, userId, volume } = input;
	if (mode === "replace") {
		await enqueueVolumeRestore(volume, key, options);
		logger.info(
			`Restore queued: volume=${volume.id} key=${key} user=${userId}`,
		);
		return `Restoring ${key} into ${volume.name}.`;
	}
	if (mode === "backupFirst") {
		const backup = await enqueueVolumeBackup(volume);
		await enqueueVolumeRestore(volume, key, options, backup.id);
		logger.info(
			`Backup then restore queued: volume=${volume.id} key=${key} backup=${backup.id} user=${userId}`,
		);
		return `Backing up ${volume.name}, then restoring ${key} into it.`;
	}
	const row = volume.toJSON();
	if (row.kind !== "volume") {
		throw new Error(
			"Restoring as a revision needs a Docker volume: a host path can't be cloned into a new one.",
		);
	}
	const names = restoredVolumeNames(volume.name, new Date());
	const restored = await StorageVolumeDTO.create({
		description: `Restored from ${key}`,
		kind: "volume",
		name: names.name,
		source: names.source,
		userId: row.userId,
	});
	await restored.update({
		backupEnabled: row.backupEnabled,
		backupPrefix: row.backupPrefix,
		backupPreCommand: row.backupPreCommand,
		backupPreCommandServiceId: row.backupPreCommandServiceId,
		backupSchedule: row.backupSchedule,
		backupStopServices: row.backupStopServices,
		s3DestinationId: row.s3DestinationId,
	});
	const restore = await enqueueVolumeRestore(restored, key, {
		stopServices: false,
		wipe: false,
	});
	await DeploymentService.enqueueDeploy({
		dependsOnJobId: restore.id,
		mountSwap: { from: volume.id, to: restored.id },
		note: `Restoring ${key} into a new volume, ${restored.name}, mounted in place of ${volume.name}.`,
		svc,
		trigger: "manual",
		userId,
	});
	logger.info(
		`Restore as revision queued: service=${svc.id} from=${volume.id} to=${restored.id} key=${key} user=${userId}`,
	);
	return `Restoring ${key} into ${restored.name}, then redeploying ${svc.name} with it.`;
}
