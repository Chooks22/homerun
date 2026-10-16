import { error, fail, redirect } from "@sveltejs/kit";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { parseDestinationForm } from "#lib/server/backup-destination-form.js";
import { BackupCapacityService } from "#lib/services/backup-capacity.service.js";
import { S3BackupService } from "#lib/services/s3-backup.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("S3Destinations");

export const load = async ({ params, parent }) => {
	await parent();

	const destination = await S3DestinationDTO.get(params.destinationId);
	if (!destination) {
		error(404, "Destination not found");
	}
	const volumes = await StorageVolumeDTO.listForDestination(destination.id);
	const row = destination.toJSON();

	return {
		destination: {
			accessKeyId: row.accessKeyId,
			backupKeep: row.backupKeep,
			bucket: row.bucket,
			capacity: destination.capacity,
			capacityAlertPercent: row.capacityAlertPercent,
			capacityCheckedAt: row.capacityCheckedAt,
			capacityError: row.capacityError,
			createdAt: row.createdAt,
			endpoint: row.endpoint,
			id: row.id,
			name: row.name,
			region: row.region,
			type: row.type,
			updatedAt: row.updatedAt,
		},
		volumes: volumes.map((volume) => ({
			backupEnabled: volume.backupEnabled,
			id: volume.id,
			name: volume.name,
		})),
	};
};

export const actions = {
	checkCapacity: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const destination = await S3DestinationDTO.get(params.destinationId);
		if (!destination) {
			return fail(404, { error: "Destination not found." });
		}
		const result = await BackupCapacityService.check(destination);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		return { success: true };
	},

	setCapacityAlert: async ({ params, request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const destination = await S3DestinationDTO.get(params.destinationId);
		if (!destination) {
			return fail(404, { error: "Destination not found." });
		}
		const percent = Number(
			String((await request.formData()).get("capacityAlertPercent") ?? ""),
		);
		if (!Number.isInteger(percent) || percent < 50 || percent > 99) {
			return fail(400, {
				error: "The threshold is a whole number from 50 to 99.",
			});
		}
		await destination.setCapacityAlertPercent(percent);
		logger.info(
			`Backup destination capacity threshold set: destination=${destination.id} percent=${percent} user=${locals.user.id}`,
		);
		return { success: true };
	},

	test: async ({ params, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}

		const destination = await S3DestinationDTO.get(params.destinationId);
		if (!destination) {
			return fail(404, { error: "Destination not found." });
		}

		try {
			await S3BackupService.testDestination(destination);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(
				`Backup destination test failed: destination=${destination.id} user=${locals.user.id} error=${message}`,
			);
			return fail(400, { error: message, tested: true });
		}
		logger.info(
			`Backup destination tested: destination=${destination.id} user=${locals.user.id}`,
		);
		return { success: true, tested: true };
	},

	update: async ({ params, request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}

		const destination = await S3DestinationDTO.get(params.destinationId);
		if (!destination) {
			return fail(404, { error: "Destination not found." });
		}

		const formData = await request.formData();
		formData.set("type", destination.type);
		const result = parseDestinationForm(formData, { keepSecret: true });
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		const keep = String(formData.get("backupKeep") ?? "").trim();
		const backupKeep = keep ? Number(keep) : null;
		if (
			backupKeep !== null &&
			!(Number.isInteger(backupKeep) && backupKeep >= 1)
		) {
			return fail(400, {
				error:
					"Backups to keep is a whole number of at least 1, or empty to keep them all.",
			});
		}

		await destination.update({ ...result.parsed, backupKeep });
		logger.info(
			`Backup destination updated: destination=${destination.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
