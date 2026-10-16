import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import {
	backupConfigError,
	volumeBackupGuard,
} from "#lib/server/volume-backup-form.js";
import { storageVolumeProblem } from "#lib/storage-volume-input.js";

const logger = new Logger("Storage");

/** A volume change refused for the caller's input; nothing was saved. */
export class VolumeSettingsError extends Error {}

export interface VolumeSettingsInput {
	backupEnabled?: boolean;
	backupPreCommand?: string | null;
	backupPreCommandServiceId?: string | null;
	backupPrefix?: string | null;
	backupSchedule?: string | null;
	backupStopServices?: boolean;
	description?: string | null;
	name?: string;
	s3DestinationId?: string | null;
}

/**
 * Creating storage volumes and changing their name and backup settings,
 * shared by the Storage pages and the REST API.
 */
class VolumeSettingsServiceClass {
	/**
	 * Registers a volume (a host path or a Docker volume) and applies any
	 * backup settings given with it.
	 *
	 * @throws {VolumeSettingsError} When a field is invalid; nothing is
	 *   created then.
	 */
	async create(
		input: VolumeSettingsInput & {
			kind: string | null;
			name: string;
			source: string;
		},
		userId: string,
	): Promise<StorageVolumeDTO> {
		const problem = storageVolumeProblem(input);
		if (problem) {
			throw new VolumeSettingsError(problem);
		}
		const { kind, name, source, description, ...settings } = input;
		const volume = await StorageVolumeDTO.create({
			description: description?.trim() || null,
			kind: kind === "bind" ? "bind" : "volume",
			name: name.trim(),
			source: source.trim(),
			userId,
		});
		try {
			await this.apply(volume, settings);
		} catch (err) {
			await volume.delete();
			throw err;
		}
		logger.info(
			`Storage volume created: volume=${volume.id} kind=${kind} user=${userId}`,
		);
		return volume;
	}

	/**
	 * Applies the fields `input` carries to `volume`. Turning backups on
	 * without a schedule picks the default nightly one.
	 *
	 * @throws {VolumeSettingsError} When the name is blank or the backup
	 *   settings don't hold together; nothing is saved then.
	 */
	async apply(
		volume: StorageVolumeDTO,
		input: VolumeSettingsInput,
	): Promise<void> {
		if (input.name !== undefined && !input.name.trim()) {
			throw new VolumeSettingsError("Name is required.");
		}
		const row = volume.toJSON();
		const backupEnabled = input.backupEnabled ?? row.backupEnabled;
		const backupSchedule =
			input.backupSchedule === undefined
				? row.backupSchedule
				: input.backupSchedule?.trim() || null;
		const s3DestinationId =
			input.s3DestinationId === undefined
				? row.s3DestinationId
				: input.s3DestinationId || null;
		const configError = await backupConfigError({
			enabled: backupEnabled,
			s3DestinationId,
			schedule: backupSchedule,
		});
		if (configError) {
			throw new VolumeSettingsError(configError);
		}
		const guard = await volumeBackupGuard(
			{
				backupPreCommand:
					input.backupPreCommand === undefined
						? row.backupPreCommand
						: input.backupPreCommand,
				backupPreCommandServiceId:
					input.backupPreCommandServiceId === undefined
						? row.backupPreCommandServiceId
						: input.backupPreCommandServiceId,
				backupStopServices: input.backupStopServices ?? row.backupStopServices,
			},
			volume,
		);
		if (guard.error !== null) {
			throw new VolumeSettingsError(guard.error);
		}
		await volume.update({
			backupEnabled,
			backupPrefix:
				input.backupPrefix === undefined
					? row.backupPrefix
					: input.backupPrefix?.trim() || null,
			backupSchedule,
			s3DestinationId,
			...guard.fields,
			...(input.name === undefined ? {} : { name: input.name.trim() }),
			...(input.description === undefined
				? {}
				: { description: input.description?.trim() || null }),
		});
	}
}

export const VolumeSettingsService = new VolumeSettingsServiceClass();
