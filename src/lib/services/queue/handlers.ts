import { JobDTO } from "#lib/dto/job-dto.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import type { JobType } from "#lib/types.js";
import { NotificationChannelService } from "../notification-channel.service.ts";
import { ObjectStorageService } from "../object-storage.service.ts";
import { RegistryService } from "../registry.service.ts";
import { S3BackupService } from "../s3-backup.service.ts";
import {
	type CoreServiceJob,
	coreServiceJobPayload,
	notificationDeliveryJobPayload,
} from "./payloads.ts";

export type JobResult = Record<string, unknown> | null;
type JobHandler = (job: JobDTO) => Promise<JobResult>;

async function runNotificationDelivery(entry: JobDTO): Promise<JobResult> {
	const { channelId, message } = notificationDeliveryJobPayload.parse(
		entry.payload,
	);
	return await NotificationChannelService.retryDelivery(channelId, message);
}

const coreServiceSteps: Record<
	CoreServiceJob["action"],
	{ done: string; start: string }
> = {
	disableBuiltinStore: {
		done: "Built-in object store stopped. Its volumes are kept.",
		start: "Stopping the built-in object store's container.",
	},
	enableBuiltinStore: {
		done: "Built-in object store is up.",
		start: "Starting the built-in object store and waiting for it to answer.",
	},
	publishBuiltinStore: {
		done: "Built-in object store reconfigured.",
		start: "Reconfiguring the built-in object store's Traefik route.",
	},
	publishRegistry: {
		done: "Docker registry reconfigured.",
		start: "Reconfiguring the Docker registry's Traefik route.",
	},
	setRegistryAuth: {
		done: "Docker registry auth updated.",
		start: "Rewriting the registry's credentials and recreating its container.",
	},
};

/** Runs one core service change (the built-in object store, the Docker registry), logging its start and end to the job. */
async function runCoreService(entry: JobDTO): Promise<JobResult> {
	const payload = coreServiceJobPayload.parse(entry.payload);
	const steps = coreServiceSteps[payload.action];
	await JobDTO.appendLog(entry.id, steps.start);
	switch (payload.action) {
		case "enableBuiltinStore":
			await ObjectStorageService.enableBuiltin(payload.userId);
			break;
		case "disableBuiltinStore":
			await ObjectStorageService.disableBuiltin();
			break;
		case "publishBuiltinStore":
			await ObjectStorageService.setBuiltinPublicHost(payload.host);
			break;
		case "setRegistryAuth":
			await RegistryService.setAuthEnabled(payload.enabled);
			break;
		case "publishRegistry":
			await RegistryService.setPublicHost(payload.host);
			break;
	}
	await JobDTO.appendLog(entry.id, steps.done);
	return { action: payload.action };
}

/** Prunes one volume's archives, logging the outcome to the job; returns how many went, or null when it failed. */
async function pruneVolume(
	entry: JobDTO,
	volume: StorageVolumeDTO,
	keep: number,
): Promise<number | null> {
	try {
		const deleted = await S3BackupService.pruneBackups(volume);
		await JobDTO.appendLog(
			entry.id,
			deleted.length > 0
				? `${volume.name}: kept the newest ${keep}, deleted ${deleted.length}: ${deleted.join(", ")}`
				: `${volume.name}: nothing past the newest ${keep}`,
		);
		return deleted.length;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await JobDTO.appendLog(entry.id, `${volume.name}: failed: ${message}`);
		return null;
	}
}

/**
 * Deletes every volume's archives past its destination's `backupKeep`, one
 * volume at a time, logging each to the job.
 *
 * @throws After every volume was tried, when any of them couldn't be cleaned up.
 */
async function runBackupPrune(entry: JobDTO): Promise<JobResult> {
	const keeps = new Map(
		(await S3DestinationDTO.list()).map((d) => [d.id, d.backupKeep]),
	);
	const volumes = (await StorageVolumeDTO.list()).filter(
		(volume) => volume.s3DestinationId && keeps.get(volume.s3DestinationId),
	);
	await JobDTO.appendLog(
		entry.id,
		`Cleaning up ${volumes.length} volumes on destinations with a backup limit`,
	);
	let deleted = 0;
	const failed: string[] = [];
	for (const volume of volumes) {
		const keep = keeps.get(volume.s3DestinationId ?? "") ?? 0;
		// oxlint-disable-next-line no-await-in-loop -- one volume at a time: storage boxes cap concurrent connections
		const count = await pruneVolume(entry, volume, keep);
		if (count === null) {
			failed.push(volume.name);
		} else {
			deleted += count;
		}
	}
	await JobDTO.appendLog(entry.id, `Deleted ${deleted} old backups`);
	if (failed.length > 0) {
		throw new Error(
			`Deleted ${deleted} old backups, but couldn't clean up ${failed.join(", ")}: see the log.`,
		);
	}
	return { deleted };
}

export const jobHandlers: Partial<Record<JobType, JobHandler>> = {
	backup_prune: runBackupPrune,
	core_service: runCoreService,
	notification_delivery: runNotificationDelivery,
};
