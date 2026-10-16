import {
	and,
	count,
	desc,
	eq,
	inArray,
	notExists,
	notInArray,
	type SQL,
} from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import {
	type StorageVolume,
	serviceVolume,
	storageVolume,
} from "#lib/server/db/schema.js";
import {
	type ListQuery,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { BaseDTO } from "./base-dto";

export interface NewStorageVolumeInput {
	description?: string | null;
	kind: "bind" | "volume";
	name: string;
	previewServiceId?: string | null;
	seedFrom?: string | null;
	source: string;
	userId: string;
}

export type StorageVolumeUpdateInput = Partial<
	Pick<
		StorageVolume,
		| "backupEnabled"
		| "backupLastRunAt"
		| "backupPrefix"
		| "backupPreCommand"
		| "backupPreCommandServiceId"
		| "backupSchedule"
		| "backupStopServices"
		| "description"
		| "name"
		| "s3DestinationId"
	>
>;

/** Wraps the `storage_volume` table : see ServiceDTO for the pattern this follows. */
export class StorageVolumeDTO extends BaseDTO<StorageVolume> {
	/** Loads one storage volume by id; null when missing. */
	static async get(id: string): Promise<StorageVolumeDTO | null> {
		const [row] = await db
			.select()
			.from(storageVolume)
			.where(eq(storageVolume.id, id))
			.limit(1);
		return row ? new StorageVolumeDTO(row) : null;
	}

	/** Every storage volume on the instance, newest first. */
	static async list(): Promise<StorageVolumeDTO[]> {
		const rows = await db
			.select()
			.from(storageVolume)
			.orderBy(desc(storageVolume.createdAt));
		return rows.map((row) => new StorageVolumeDTO(row));
	}

	/** One page of `list`, searched/filtered server-side, plus the unpaged total. */
	static async listPaged(
		query: ListQuery,
	): Promise<PagedResult<StorageVolumeDTO>> {
		const conditions: SQL[] = [];
		const search = searchCondition(query.q, [
			storageVolume.name,
			storageVolume.source,
			storageVolume.description,
		]);
		if (search) {
			conditions.push(search);
		}
		const kinds = query.filters.kind;
		if (kinds && kinds.length > 0) {
			conditions.push(inArray(storageVolume.kind, kinds));
		}
		const backup = query.filters.backup;
		if (backup && backup.length === 1) {
			conditions.push(eq(storageVolume.backupEnabled, backup[0] === "on"));
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(storageVolume)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: storageVolume.createdAt,
							name: storageVolume.name,
							updated: storageVolume.updatedAt,
						},
						desc(storageVolume.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(storageVolume).where(where),
		]);

		return {
			items: rows.map((row) => new StorageVolumeDTO(row)),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/** The volumes copied for a pull request preview, which go when it goes. */
	static async listForPreview(serviceId: string): Promise<StorageVolumeDTO[]> {
		const rows = await db
			.select()
			.from(storageVolume)
			.where(eq(storageVolume.previewServiceId, serviceId));
		return rows.map((row) => new StorageVolumeDTO(row));
	}

	/** The volumes these services mount that no other service mounts too, the ones safe to delete along with them. */
	static async listExclusiveTo(
		serviceIds: string[],
	): Promise<StorageVolumeDTO[]> {
		const others = db
			.select({ id: serviceVolume.id })
			.from(serviceVolume)
			.where(
				and(
					eq(serviceVolume.volumeId, storageVolume.id),
					notInArray(serviceVolume.serviceId, serviceIds),
				),
			);
		const rows = await db
			.selectDistinct({ volume: storageVolume })
			.from(storageVolume)
			.innerJoin(serviceVolume, eq(serviceVolume.volumeId, storageVolume.id))
			.where(
				and(inArray(serviceVolume.serviceId, serviceIds), notExists(others)),
			);
		return rows.map((row) => new StorageVolumeDTO(row.volume));
	}

	/** Every volume (across all users) with scheduled backups turned on : for the scheduler tick, same pattern as ServiceDTO.listCronEnabled. */
	static async listBackupEnabled(): Promise<StorageVolumeDTO[]> {
		const rows = await db
			.select()
			.from(storageVolume)
			.where(eq(storageVolume.backupEnabled, true));
		return rows.map((row) => new StorageVolumeDTO(row));
	}

	/** Every volume whose backups go to this destination, by name. */
	static async listForDestination(
		destinationId: string,
	): Promise<StorageVolumeDTO[]> {
		const rows = await db
			.select()
			.from(storageVolume)
			.where(eq(storageVolume.s3DestinationId, destinationId))
			.orderBy(storageVolume.name);
		return rows.map((row) => new StorageVolumeDTO(row));
	}

	/**
	 * Up to `limit` volumes whose name, source or description
	 * matches `q`, newest first, for global search.
	 */
	static async search(q: string, limit: number): Promise<StorageVolumeDTO[]> {
		const rows = await db
			.select()
			.from(storageVolume)
			.where(
				searchCondition(q, [
					storageVolume.name,
					storageVolume.source,
					storageVolume.description,
				]),
			)
			.orderBy(desc(storageVolume.createdAt))
			.limit(limit);
		return rows.map((row) => new StorageVolumeDTO(row));
	}

	/**
	 * Inserts a new volume record with backups off. Only the row : the Docker
	 * volume or host path isn't touched.
	 */
	static async create(input: NewStorageVolumeInput): Promise<StorageVolumeDTO> {
		const now = new Date();
		const row: StorageVolume = {
			backupEnabled: false,
			backupLastRunAt: null,
			backupPrefix: null,
			backupPreCommand: null,
			backupPreCommandServiceId: null,
			backupSchedule: null,
			backupStopServices: false,
			createdAt: now,
			description: input.description ?? null,
			id: crypto.randomUUID(),
			kind: input.kind,
			name: input.name,
			previewServiceId: input.previewServiceId ?? null,
			s3DestinationId: null,
			seedFrom: input.seedFrom ?? null,
			source: input.source,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(storageVolume).values(row);
		return new StorageVolumeDTO(row);
	}

	/**
	 * Writes the given name, description or backup fields to the row and
	 * mirrors them onto this instance.
	 */
	async update(input: StorageVolumeUpdateInput): Promise<void> {
		await db
			.update(storageVolume)
			.set(input)
			.where(eq(storageVolume.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Row-only delete : the `service_volume` FK is `onDelete: cascade`, so any mounts referencing this volume go with it. */
	async delete(): Promise<void> {
		await db.delete(storageVolume).where(eq(storageVolume.id, this.row.id));
	}

	/** The volume's id. */
	get id(): string {
		return this.row.id;
	}
	/** The id of the user who created the volume. */
	get userId(): string {
		return this.row.userId;
	}
	/** The volume's display name. */
	get name(): string {
		return this.row.name;
	}
	/** Whether it is a host bind mount or a named Docker volume. */
	get kind(): StorageVolume["kind"] {
		return this.row.kind;
	}
	/** The host path for a bind mount, or the Docker volume name. */
	get source(): string {
		return this.row.source;
	}
	/** Whether scheduled S3 backups are on for this volume. */
	get backupEnabled(): boolean {
		return this.row.backupEnabled;
	}
	/** The backup cron expression, if one is set. */
	get backupSchedule(): string | null {
		return this.row.backupSchedule;
	}
	/** When the last scheduled backup started, null if never. */
	get backupLastRunAt(): Date | null {
		return this.row.backupLastRunAt;
	}
	/** The key prefix backups are uploaded under, if one is set. */
	get backupPrefix(): string | null {
		return this.row.backupPrefix;
	}
	/** Whether services using this volume are stopped while it's backed up. */
	get backupStopServices(): boolean {
		return this.row.backupStopServices;
	}
	/** A shell command run inside a service's container before each backup (a database dump, say), if one is set. */
	get backupPreCommand(): string | null {
		return this.row.backupPreCommand;
	}
	/** The service whose container runs `backupPreCommand`, null to use the first running service that mounts this volume. */
	get backupPreCommandServiceId(): string | null {
		return this.row.backupPreCommandServiceId;
	}
	/** The S3 destination backups go to, if one is chosen. */
	get s3DestinationId(): string | null {
		return this.row.s3DestinationId;
	}
}
