import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import type { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { stackPath } from "#lib/stack-tree.js";
import {
	deleteRemoteFile,
	listRemoteBackups,
	type RcloneRemote,
	rcloneRemote,
	testRemote,
} from "./backup/rclone.ts";
import {
	VOLUME_HELPER_IMAGE,
	VOLUME_HELPER_MOUNT_PATH,
	VOLUME_HELPER_TAG,
	VolumeServices,
} from "./backup/volume-services.ts";
import { MANAGED_LABEL } from "./docker/labels.ts";
import { expectS3Ok, s3Fetch } from "./s3/signer.ts";

export interface RestoreOptions {
	stopServices: boolean;
	wipe: boolean;
}

export interface S3Config {
	accessKeyId: string;
	bucket: string;
	// Full endpoint URL, e.g. "https://s3.us-east-1.amazonaws.com" or a
	// self-hosted MinIO URL. Path-style addressing is used (bucket in the
	// path, not the hostname) : works against both AWS and MinIO.
	endpoint: string;
	region: string;
	secretAccessKey: string;
}

export type BackupTarget = { destination: S3Config } | { remote: RcloneRemote };

export interface BackupObject {
	key: string;
	lastModified: string | null;
	sizeBytes: number;
}

const CONTENTS_RE = /<Contents>([\s\S]*?)<\/Contents>/g;
const BACKUP_SUFFIX = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar\.gz`;

/**
 * Matches exactly the keys `backupSpec` writes under `prefix`, so a volume
 * named `db` never claims `db-data`'s archives.
 */
export function backupKeyPattern(prefix: string): RegExp {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}${BACKUP_SUFFIX}$`);
}

function tagValue(xml: string, tag: string): string | null {
	const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
	return match?.[1] ?? null;
}

/** ListObjectsV2, parsed out of the XML response : no SDK, same posture as putObject. */
async function listObjects(
	config: S3Config,
	prefix: string,
): Promise<BackupObject[]> {
	const res = await s3Fetch(config, {
		method: "GET",
		path: `/${config.bucket}`,
		query: { "list-type": "2", "max-keys": "200", prefix },
	});
	await expectS3Ok(res, "LIST");
	const xml = await res.text();
	const objects: BackupObject[] = [];
	CONTENTS_RE.lastIndex = 0;
	let match: RegExpExecArray | null = CONTENTS_RE.exec(xml);
	while (match) {
		const body = match[1];
		const key = tagValue(body, "Key");
		if (key?.endsWith(".tar.gz")) {
			objects.push({
				key,
				lastModified: tagValue(body, "LastModified"),
				sizeBytes: Number.parseInt(tagValue(body, "Size") ?? "0", 10),
			});
		}
		match = CONTENTS_RE.exec(xml);
	}
	return objects.sort((a, b) => b.key.localeCompare(a.key));
}

class S3BackupServiceClass {
	/**
	 * Everything the Go worker needs to back `volume` up: its decrypted
	 * destination, a fresh timestamped key, the pre-backup command's target
	 * and, with `backupStopServices`, the running services to stop around it.
	 *
	 * @throws When the destination can't be resolved or the pre-backup
	 *   command has nowhere to run.
	 */
	async backupSpec(volume: StorageVolumeDTO): Promise<Record<string, unknown>> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const prefix = volume.backupPrefix ? `${volume.backupPrefix}/` : "";
		const services = await VolumeServices.servicesUsing(volume);
		return {
			...(await this.#helperSpec(volume, services)),
			...(await this.destinationFor(volume)),
			key: `${prefix}${volume.name}-${timestamp}.tar.gz`,
			preCommand: await VolumeServices.preCommandTarget(volume),
			stopServices: volume.backupStopServices
				? await VolumeServices.stopTargets(services)
				: [],
		};
	}

	/**
	 * Everything the Go worker needs to restore backup `key` into `volume`,
	 * with the running services using it to stop when `options.stopServices`.
	 *
	 * @throws When the destination can't be resolved.
	 */
	async restoreSpec(
		volume: StorageVolumeDTO,
		key: string,
		options: RestoreOptions,
	): Promise<Record<string, unknown>> {
		const services = await VolumeServices.servicesUsing(volume);
		return {
			...(await this.#helperSpec(volume, services)),
			...(await this.destinationFor(volume)),
			key,
			stopServices: options.stopServices
				? await VolumeServices.stopTargets(services)
				: [],
			wipe: options.wipe,
		};
	}

	/**
	 * The helper container the worker mounts the volume into, shared by backup
	 * and restore specs, plus the volume's kind and the services using it,
	 * each with its stack path, for the run log.
	 */
	async #helperSpec(
		volume: StorageVolumeDTO,
		services: ServiceDTO[],
	): Promise<Record<string, unknown>> {
		const stacks = services.some((s) => s.stackId)
			? (await StackDTO.list()).map((s) => s.toJSON())
			: [];
		return {
			helperImage: `${VOLUME_HELPER_IMAGE}:${VOLUME_HELPER_TAG}`,
			helperLabels: { [MANAGED_LABEL]: "true" },
			kind: volume.kind,
			mountPath: VOLUME_HELPER_MOUNT_PATH,
			source: volume.source,
			usedBy: services.map((s) =>
				s.stackId ? `${s.name} (${stackPath(s.stackId, stacks)})` : s.name,
			),
			volumeName: volume.name,
		};
	}

	/** The backups that exist for this volume, newest first : what the Restore picker lists. */
	async listBackups(volume: StorageVolumeDTO): Promise<BackupObject[]> {
		return await this.#listBackups(volume, await this.destinationFor(volume));
	}

	/**
	 * Deletes `volume`'s archives on its destination beyond the newest
	 * `backupKeep`: after the backup that wrote `latestKey` succeeded, or on
	 * demand without one. Does nothing when every backup is kept.
	 *
	 * @returns The deleted keys, oldest last.
	 * @throws When the destination can't be listed or an archive can't be
	 *   deleted, or when `latestKey` is given but isn't listed: pruning against
	 *   a listing that misses the newest archive could delete the ones worth
	 *   keeping.
	 */
	async pruneBackups(
		volume: StorageVolumeDTO,
		latestKey?: string,
	): Promise<string[]> {
		const keep = volume.backupKeep;
		if (!keep) {
			return [];
		}
		const target = await this.destinationFor(volume);
		const backups = await this.#listBackups(volume, target);
		if (latestKey && !backups.some((backup) => backup.key === latestKey)) {
			throw new Error(
				`${latestKey} isn't listed on the destination, so no older backup was deleted.`,
			);
		}
		const stale = backups.slice(keep).map((backup) => backup.key);
		for (const key of stale) {
			// oxlint-disable-next-line no-await-in-loop -- one rclone container at a time: storage boxes cap concurrent connections
			await this.#deleteBackup(target, key);
		}
		return stale;
	}

	/** Deletes one archive on `target`: a signed `DELETE`, or `rclone deletefile`. */
	async #deleteBackup(target: BackupTarget, key: string): Promise<void> {
		if ("remote" in target) {
			await deleteRemoteFile(target.remote, key);
			return;
		}
		await expectS3Ok(
			await s3Fetch(target.destination, {
				method: "DELETE",
				path: `/${target.destination.bucket}/${key}`,
			}),
			"DELETE",
		);
	}

	/** `volume`'s archives on `target`, newest first, matched by `backupKeyPattern`. */
	async #listBackups(
		volume: StorageVolumeDTO,
		target: BackupTarget,
	): Promise<BackupObject[]> {
		const prefix = volume.backupPrefix
			? `${volume.backupPrefix}/${volume.name}-`
			: `${volume.name}-`;
		const objects =
			"remote" in target
				? await listRemoteBackups(target.remote, prefix)
				: await listObjects(target.destination, prefix);
		const pattern = backupKeyPattern(prefix);
		return objects.filter((object) => pattern.test(object.key));
	}

	/**
	 * Resolves and decrypts a volume's destination: an `S3Config` for an S3
	 * one, the rclone helper that reaches it for an SFTP, SMB or WebDAV one.
	 *
	 * @throws When the volume has no destination picked, the destination row
	 *   no longer exists, or its secret can't be decrypted.
	 */
	async destinationFor(volume: StorageVolumeDTO): Promise<BackupTarget> {
		if (!volume.s3DestinationId) {
			throw new Error("No backup destination picked for this volume.");
		}
		const row = await S3DestinationDTO.get(volume.s3DestinationId);
		if (!row) {
			throw new Error("The picked backup destination no longer exists.");
		}
		return this.targetOf(row);
	}

	/**
	 * Proves a destination works with its saved settings by writing a small
	 * test file to it and deleting it again: a signed PUT and DELETE for an S3
	 * one, a one-off rclone container for an SFTP, SMB or WebDAV one.
	 *
	 * @throws With the endpoint's or rclone's own error when it can't be
	 *   reached, logged into or written to.
	 */
	async testDestination(row: S3DestinationDTO): Promise<void> {
		const target = this.targetOf(row);
		if ("remote" in target) {
			await testRemote(target.remote);
			return;
		}
		const path = `/${target.destination.bucket}/.homerun-test-${crypto.randomUUID()}`;
		await expectS3Ok(
			await s3Fetch(target.destination, {
				body: "homerun",
				method: "PUT",
				path,
			}),
			"PUT",
		);
		await expectS3Ok(
			await s3Fetch(target.destination, { method: "DELETE", path }),
			"DELETE",
		);
	}

	/**
	 * Decrypts a destination row into what reaches it: an `S3Config`, or the
	 * rclone helper for an SFTP, SMB or WebDAV one.
	 *
	 * @throws When its secret can't be decrypted.
	 */
	targetOf(row: S3DestinationDTO): BackupTarget {
		const secretAccessKey = row.decryptSecretAccessKey();
		if (!secretAccessKey) {
			throw new Error("Couldn't decrypt the destination's stored secret.");
		}
		if (row.type !== "s3") {
			return {
				remote: rcloneRemote({
					host: row.endpoint,
					path: row.bucket,
					secret: secretAccessKey,
					type: row.type,
					username: row.accessKeyId,
				}),
			};
		}
		return {
			destination: {
				accessKeyId: row.accessKeyId,
				bucket: row.bucket,
				endpoint: row.endpoint,
				region: row.region,
				secretAccessKey,
			},
		};
	}
}

export const S3BackupService = new S3BackupServiceClass();
