import { error, fail, redirect } from "@sveltejs/kit";
import { BackupRunDTO } from "#lib/dto/backup-run-dto.js";
import { JobDTO } from "#lib/dto/job-dto.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { VolumeServices } from "#lib/services/backup/volume-services.js";
import {
	cancelBackupRun,
	enqueueVolumeBackup,
	enqueueVolumeRestore,
} from "#lib/services/backup-queue.js";
import {
	VolumeSettingsError,
	VolumeSettingsService,
} from "#lib/services/volume-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("Storage");

export const load = async ({ params, parent }) => {
	await parent();
	const volume = await StorageVolumeDTO.get(params.volumeId);
	if (!volume) {
		error(404, "Volume not found");
	}
	const [runs, destinations, services] = await Promise.all([
		BackupRunDTO.listForVolume(volume.id),
		S3DestinationDTO.list(),
		VolumeServices.servicesUsing(volume),
	]);
	const logs = await JobDTO.logsFor(runs.map((r) => r.toJSON().jobId));
	return {
		destinations: destinations.map((d) => d.toJSON()),
		runs: runs.map((r) => {
			const row = r.toJSON();
			return { ...row, log: (row.jobId && logs.get(row.jobId)) || "" };
		}),
		services: services.map((service) => ({
			id: service.id,
			name: service.name,
		})),
	};
};

export const actions = {
	cancelRun: async ({ request, params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const run = await BackupRunDTO.get(
			String((await request.formData()).get("runId") ?? ""),
		);
		if (!run || run.toJSON().volumeId !== params.volumeId) {
			return fail(404, { error: "That run doesn't exist any more." });
		}
		if (!(await cancelBackupRun(run, locals.user.name || locals.user.email))) {
			return fail(400, { error: "That run already finished." });
		}
		logger.info(
			`Backup run cancelled: volume=${params.volumeId} run=${run.toJSON().id} user=${locals.user.id}`,
		);
		return { cancelled: true };
	},

	backupNow: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}

		await volume.update({ backupLastRunAt: new Date() });
		const entry = await enqueueVolumeBackup(volume);
		logger.info(`Manual backup queued: volume=${volume.id} job=${entry.id}`);
		return { backupSuccess: true };
	},

	restore: async ({ request, params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const formData = await request.formData();
		const key = (formData.get("key") as string | null)?.trim();
		if (!key) {
			return fail(400, { error: "Pick a backup to restore." });
		}

		const options = {
			stopServices: formData.get("stopServices") === "on",
			wipe: formData.get("wipe") === "on",
		};
		const entry = await enqueueVolumeRestore(volume, key, options);
		logger.info(
			`Restore queued: volume=${volume.id} key=${key} wipe=${options.wipe} stopServices=${options.stopServices} job=${entry.id}`,
		);
		return { restoredKey: key, success: true };
	},

	updateBackup: async ({ request, params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}

		const formData = await request.formData();
		const backupEnabled = formData.get("backupEnabled") === "on";
		try {
			await VolumeSettingsService.apply(volume, {
				backupEnabled,
				backupPreCommand: formData.get("backupPreCommand") as string | null,
				backupPreCommandServiceId: formData.get("backupPreCommandServiceId") as
					| string
					| null,
				backupPrefix: formData.get("backupPrefix") as string | null,
				backupSchedule: formData.get("backupSchedule") as string | null,
				backupStopServices: formData.get("backupStopServices") === "on",
				s3DestinationId: formData.get("s3DestinationId") as string | null,
			});
		} catch (err) {
			if (err instanceof VolumeSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}

		logger.info(
			`Backup config updated: volume=${volume.id} enabled=${backupEnabled} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
