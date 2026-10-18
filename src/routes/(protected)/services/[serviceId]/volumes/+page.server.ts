import { fail } from "@sveltejs/kit";
import { HOST_VOLUME_PREFIX } from "#lib/constants.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceVolumeDTO } from "#lib/dto/service-volume-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { restoreBackupFormSchema } from "#lib/server/validation/volume-restore.js";
import {
	backupConfigError,
	DEFAULT_BACKUP_SCHEDULE,
} from "#lib/server/volume-backup-form.js";
import { restoreVolumeBackup } from "#lib/services/backup/volume-restore.js";
import {
	VolumeSettingsError,
	VolumeSettingsService,
} from "#lib/services/volume-settings.service.js";

const logger = new Logger("Services");

export const load = async ({ params, parent }) => {
	await parent();
	const [volumes, mounts, destinations] = await Promise.all([
		StorageVolumeDTO.list(),
		ServiceVolumeDTO.listForService(params.serviceId),
		S3DestinationDTO.list(),
	]);

	return {
		destinations: destinations.map((d) => ({ id: d.id, name: d.name })),
		mounts: mounts.map((m) => ({
			...m.mount.toJSON(),
			volumeKind: m.volumeKind,
			volumeName: m.volumeName,
		})),
		volumes: volumes.map((v) => v.toJSON()),
	};
};

export const actions = {
	restoreBackup: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = restoreBackupFormSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!parsed.success) {
			return fail(400, {
				error: parsed.error.issues[0]?.message ?? "Invalid restore.",
			});
		}
		const [svc, volume, mounts] = await Promise.all([
			ServiceDTO.get(params.serviceId),
			StorageVolumeDTO.get(parsed.data.volumeId),
			ServiceVolumeDTO.listForService(params.serviceId),
		]);
		if (
			!svc ||
			!volume ||
			!mounts.some(({ mount }) => mount.toJSON().volumeId === volume.id)
		) {
			return fail(404, {
				error: "That volume isn't mounted into this service.",
			});
		}
		if (parsed.data.confirm !== volume.name) {
			return fail(400, { error: `Type ${volume.name} to confirm.` });
		}
		try {
			const message = await restoreVolumeBackup({
				key: parsed.data.key,
				mode: parsed.data.mode,
				options: {
					stopServices: parsed.data.stopServices,
					wipe: parsed.data.wipe,
				},
				svc,
				userId: locals.user.id,
				volume,
			});
			return { restoreQueued: message };
		} catch (error) {
			logger.warn(`Restore couldn't be queued: volume=${volume.id}`, error);
			return fail(400, {
				error:
					error instanceof Error
						? error.message
						: "Couldn't queue the restore.",
			});
		}
	},

	toggleBackup: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const volume = await StorageVolumeDTO.get(String(formData.get("volumeId")));
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const enabled = formData.get("enabled") === "on";
		if (!enabled) {
			await volume.update({ backupEnabled: false });
			logger.info(
				`Backups turned off: volume=${volume.id} user=${locals.user.id}`,
			);
			return { backupEnabled: false, success: true };
		}
		const destinations = await S3DestinationDTO.list();
		const s3DestinationId =
			volume.s3DestinationId ??
			(destinations.length === 1 ? (destinations[0]?.id ?? null) : null);

		if (!s3DestinationId) {
			return fail(400, {
				error: "Pick where the backups go first.",
				needsSettings: volume.id,
			});
		}
		const schedule = volume.backupSchedule ?? DEFAULT_BACKUP_SCHEDULE;
		const configError = await backupConfigError({
			enabled: true,
			s3DestinationId,
			schedule,
		});
		if (configError) {
			return fail(400, { error: configError, needsSettings: volume.id });
		}
		await volume.update({
			backupEnabled: true,
			backupSchedule: schedule,
			s3DestinationId,
		});
		logger.info(
			`Backups turned on: volume=${volume.id} user=${locals.user.id}`,
		);
		return { backupEnabled: true, success: true };
	},

	configureBackup: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const volume = await StorageVolumeDTO.get(String(formData.get("volumeId")));
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const backupSchedule =
			String(formData.get("backupSchedule") ?? "").trim() || null;
		const s3DestinationId =
			String(formData.get("s3DestinationId") ?? "").trim() || null;
		const backupPrefix =
			String(formData.get("backupPrefix") ?? "").trim() || null;
		const configError = await backupConfigError({
			enabled: true,
			s3DestinationId,
			schedule: backupSchedule,
		});
		if (configError) {
			return fail(400, { error: configError, needsSettings: volume.id });
		}
		await volume.update({
			backupEnabled: true,
			backupPrefix,
			backupSchedule,
			s3DestinationId,
		});
		logger.info(
			`Backup config updated: volume=${volume.id} enabled=true user=${locals.user.id}`,
		);
		return { backupEnabled: true, success: true };
	},

	attachVolume: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const volumeId = formData.get("volumeId") as string | null;
		const containerPath = (
			formData.get("containerPath") as string | null
		)?.trim();
		const readOnly = formData.get("readOnly") === "on";

		if (!(volumeId && containerPath)) {
			return fail(400, { error: "Choose a volume and a mount path." });
		}
		if (!containerPath.startsWith("/")) {
			return fail(400, {
				error: "Mount path must be absolute (start with /).",
			});
		}

		// A `docker:<name>` choice is a volume the daemon already has that
		// Homerun hasn't registered : register it here rather than making the
		// user create it first and come back. That two-step was the whole
		// complaint about this page.
		const vol = volumeId.startsWith(HOST_VOLUME_PREFIX)
			? await StorageVolumeDTO.create({
					description: "Imported from this machine",
					kind: "volume",
					name: volumeId.slice(HOST_VOLUME_PREFIX.length),
					source: volumeId.slice(HOST_VOLUME_PREFIX.length),
					userId: locals.user.id,
				})
			: await StorageVolumeDTO.get(volumeId);
		if (!vol) {
			return fail(400, { error: "That volume wasn't found." });
		}

		await ServiceVolumeDTO.attach({
			containerPath,
			readOnly,
			serviceId: svc.id,
			volumeId: vol.id,
		});
		logger.info(
			`Volume mounted: service=${svc.id} volume=${vol.id} path=${containerPath} user=${locals.user.id}`,
		);
		return { volumeAttached: true };
	},
	// Mirrors storage/new/+page.server.ts's `create` action : lets the "New
	// volume" modal on this tab create a StorageVolume without navigating
	// away from the service (see storage/new for the full-page equivalent).
	createVolume: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const containerPath =
			(formData.get("containerPath") as string | null)?.trim() ?? "";
		if (containerPath && !containerPath.startsWith("/")) {
			return fail(400, {
				error: "Mount path must be absolute (start with /).",
			});
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		try {
			const vol = await VolumeSettingsService.create(
				{
					description: formData.get("description") as string | null,
					kind: formData.get("kind") as string | null,
					name: (formData.get("name") as string | null) ?? "",
					source: (formData.get("source") as string | null) ?? "",
				},
				locals.user.id,
			);
			if (containerPath) {
				await ServiceVolumeDTO.attach({
					containerPath,
					readOnly: formData.get("readOnly") === "on",
					serviceId: svc.id,
					volumeId: vol.id,
				});
				logger.info(
					`Volume mounted: service=${svc.id} volume=${vol.id} path=${containerPath} user=${locals.user.id}`,
				);
			}
			return {
				volumeAttached: Boolean(containerPath),
				volumeCreated: true,
				volumeId: vol.id,
			};
		} catch (err) {
			if (err instanceof VolumeSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
	},
	detachVolume: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const mountId = formData.get("mountId") as string | null;
		if (!mountId) {
			return fail(400, { error: "Missing mount id." });
		}

		// Ownership check happens by scoping to this service's own mounts :
		// never trust a mount id from the form alone.
		const mounts = await ServiceVolumeDTO.listForService(svc.id);
		const target = mounts.find((m) => m.mount.id === mountId);
		if (!target) {
			return fail(404, { error: "Mount not found." });
		}

		await target.mount.detach();
		logger.info(
			`Volume unmounted: service=${svc.id} mount=${mountId} user=${locals.user.id}`,
		);
		return { volumeDetached: true };
	},
};
