import type { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import type { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { DockerService } from "../docker.service.ts";
import type { BackupObject } from "../s3-backup.service.ts";
import { RCLONE_IMAGE, RCLONE_TAG, rcloneRemote } from "./rclone.ts";

export const RESTIC_IMAGE = "restic/restic";
export const RESTIC_TAG = "0.18.1";
export const RESTIC_KEY_PREFIX = "restic:";

const RCLONE_MOUNT_PATH = "/opt/rclone";
const REPOSITORY_NOT_FOUND = 10;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const ERROR_TAIL_CHARS = 500;
const SHORT_ID_LENGTH = 8;

const PRELUDE = `set -e
export PATH=${RCLONE_MOUNT_PATH}/usr/local/bin:$PATH
if [ -n "$HOMERUN_PASS" ]; then export RCLONE_CONFIG_DEST_PASS="$(printf %s "$HOMERUN_PASS" | rclone obscure -)"; fi
unset HOMERUN_PASS
exec restic "$@"`;

export interface ResticRepository {
	env: Record<string, string>;
	image: string;
	keep: number;
	keyPrefix: string;
	label: string;
	password: string;
	rcloneImage: string;
	repository: string;
}

interface ResticSnapshot {
	id: string;
	short_id?: string;
	summary?: { total_bytes_processed?: number };
	time: string;
}

/**
 * The rclone environment that configures remote `dest` for `row`: the same
 * one restores of legacy archives use for SFTP, SMB and WebDAV, and rclone's
 * S3 backend, path-style, for an S3 one.
 */
function rcloneEnv(
	row: S3DestinationDTO,
	secret: string,
): { env: Record<string, string>; label: string; root: string } {
	if (row.type !== "s3") {
		const remote = rcloneRemote({
			host: row.endpoint,
			path: row.bucket,
			secret,
			type: row.type,
			username: row.accessKeyId,
		});
		return { env: remote.env, label: remote.label, root: row.bucket };
	}
	return {
		env: {
			RCLONE_CONFIG_DEST_ACCESS_KEY_ID: row.accessKeyId,
			RCLONE_CONFIG_DEST_ENDPOINT: row.endpoint,
			RCLONE_CONFIG_DEST_FORCE_PATH_STYLE: "true",
			RCLONE_CONFIG_DEST_NO_CHECK_BUCKET: "true",
			RCLONE_CONFIG_DEST_PROVIDER: "Other",
			RCLONE_CONFIG_DEST_REGION: row.region,
			RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY: secret,
			RCLONE_CONFIG_DEST_TYPE: "s3",
			RCLONE_LOG_LEVEL: "ERROR",
		},
		label: `${row.endpoint.replace(/\/+$/, "")}/${row.bucket}`,
		root: row.bucket,
	};
}

/**
 * The volume whose repository a `restic:<volume id>:<snapshot id>` key's
 * snapshot is in, and the snapshot, or null for a legacy archive's key. The
 * key names its repository so a restore into another volume (a revision)
 * still finds it.
 */
export function parseResticKey(
	key: string,
): { snapshot: string; volumeId: string } | null {
	const match = key.match(/^restic:([^:]+):([0-9a-f]+)$/);
	return match ? { snapshot: match[2], volumeId: match[1] } : null;
}

/**
 * Where `volume`'s restic repository lives on `row` and how to reach it:
 * `<path>/<prefix>/restic/<volume id>` (by id, so renaming the volume keeps
 * its history), encrypted with the destination's restic password and keeping
 * the destination's `backupKeep` snapshots.
 *
 * @throws When the destination's secret or restic password can't be decrypted.
 */
export async function resticRepository(
	row: S3DestinationDTO,
	volume: StorageVolumeDTO,
): Promise<ResticRepository> {
	const secret = row.decryptSecretAccessKey();
	if (!secret) {
		throw new Error("Couldn't decrypt the destination's stored secret.");
	}
	const { env, label, root } = rcloneEnv(row, secret);
	const relative = [volume.backupPrefix, "restic", volume.id]
		.filter(Boolean)
		.join("/");
	const path = [root.replace(/\/+$/, ""), relative].filter(Boolean).join("/");
	return {
		env,
		image: `${RESTIC_IMAGE}:${RESTIC_TAG}`,
		keep: row.backupKeep ?? 0,
		keyPrefix: `${RESTIC_KEY_PREFIX}${volume.id}:`,
		label: `${label.replace(/\/+$/, "")}/${relative}`,
		password: await row.resticPassword(),
		rcloneImage: `${RCLONE_IMAGE}:${RCLONE_TAG}`,
		repository: `rclone:dest:${path}`,
	};
}

/**
 * The snapshots in `repository`, newest first, listed by a one-off restic
 * container: each keyed `restic:<volume id>:<snapshot id>`, labelled by its short id and sized by
 * what it scanned. A repository that doesn't exist yet is an empty list.
 *
 * @throws When restic can't reach or open the repository.
 */
export async function listSnapshots(
	repository: ResticRepository,
): Promise<BackupObject[]> {
	const [image, tag] = repository.image.split(":");
	const result = await DockerService.runOneOff({
		cmd: ["snapshots", "--json", "--no-lock"],
		entrypoint: ["sh", "-c", PRELUDE, "restic"],
		envVars: {
			...repository.env,
			RESTIC_PASSWORD: repository.password,
			RESTIC_REPOSITORY: repository.repository,
		},
		image: image ?? RESTIC_IMAGE,
		imageMounts: [{ image: repository.rcloneImage, target: RCLONE_MOUNT_PATH }],
		tag: tag ?? RESTIC_TAG,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	if (result.exitCode === REPOSITORY_NOT_FOUND) {
		return [];
	}
	if (result.timedOut || result.exitCode !== 0) {
		const detail = result.timedOut
			? "no answer within 5 minutes"
			: result.stderr.toString("utf8").trim().slice(-ERROR_TAIL_CHARS);
		throw new Error(
			`Couldn't list the snapshots in ${repository.label}: ${detail}`,
		);
	}
	const snapshots: ResticSnapshot[] = JSON.parse(
		result.stdout.toString("utf8") || "[]",
	);
	return snapshots
		.map((snapshot) => ({
			key: `${repository.keyPrefix}${snapshot.id}`,
			label: `Snapshot ${snapshot.short_id ?? snapshot.id.slice(0, SHORT_ID_LENGTH)}`,
			lastModified: snapshot.time,
			sizeBytes: snapshot.summary?.total_bytes_processed ?? 0,
		}))
		.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}
