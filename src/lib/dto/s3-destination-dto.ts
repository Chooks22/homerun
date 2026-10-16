import { and, count, desc, eq, ne, type SQL } from "drizzle-orm";
import {
	type Capacity,
	DEFAULT_CAPACITY_ALERT_PERCENT,
} from "#lib/backup-capacity.js";
import type { DestinationType } from "#lib/backup-destinations.js";
import { db } from "#lib/server/db/lib.js";
import { type S3Destination, s3Destination } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { decryptSecret, encryptSecret } from "#lib/services/secrets.js";
import { BaseDTO } from "./base-dto";

export interface NewS3DestinationInput {
	accessKeyId: string;
	backupKeep?: number | null;
	bucket: string;
	endpoint: string;
	name: string;
	region: string;
	secretAccessKey: string;
	type: DestinationType;
	userId: string;
}

export type S3DestinationUpdateInput = Partial<
	Pick<
		S3Destination,
		"accessKeyId" | "backupKeep" | "bucket" | "endpoint" | "name" | "region"
	>
> & {
	/** Blank/undefined means "keep the currently stored secret". */
	secretAccessKey?: string;
};

/** Wraps the `s3_destination` table : see ServiceDTO for the pattern this follows. */
export class S3DestinationDTO extends BaseDTO<S3Destination> {
	/** Loads one S3 destination by id; null when missing. */
	static async get(id: string): Promise<S3DestinationDTO | null> {
		const [row] = await db
			.select()
			.from(s3Destination)
			.where(eq(s3Destination.id, id))
			.limit(1);
		return row ? new S3DestinationDTO(row) : null;
	}

	/** Every S3 destination on the instance, newest first. */
	static async list(): Promise<S3DestinationDTO[]> {
		const rows = await db
			.select()
			.from(s3Destination)
			.orderBy(desc(s3Destination.createdAt));
		return rows.map((row) => new S3DestinationDTO(row));
	}

	/** One page of `list`, searched server-side, plus the unpaged total. */
	static async listPaged(
		query: ListQuery,
	): Promise<PagedResult<S3DestinationDTO>> {
		const conditions: SQL[] = [];
		const search = searchCondition(query.q, [
			s3Destination.name,
			s3Destination.endpoint,
			s3Destination.bucket,
			s3Destination.region,
		]);
		if (search) {
			conditions.push(search);
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(s3Destination)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: s3Destination.createdAt,
							name: s3Destination.name,
							updated: s3Destination.updatedAt,
						},
						desc(s3Destination.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(s3Destination).where(where),
		]);

		return {
			items: rows.map((row) => new S3DestinationDTO(row)),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/**
	 * Up to `limit` destinations whose name, endpoint, bucket or
	 * region matches `q`, newest first, for global search.
	 */
	static async search(q: string, limit: number): Promise<S3DestinationDTO[]> {
		const rows = await db
			.select()
			.from(s3Destination)
			.where(
				searchCondition(q, [
					s3Destination.name,
					s3Destination.endpoint,
					s3Destination.bucket,
					s3Destination.region,
				]),
			)
			.orderBy(desc(s3Destination.createdAt))
			.limit(limit);
		return rows.map((row) => new S3DestinationDTO(row));
	}

	/**
	 * Inserts a new destination, encrypting its secret access key before it is
	 * stored.
	 */
	static async create(input: NewS3DestinationInput): Promise<S3DestinationDTO> {
		const now = new Date();
		const row: S3Destination = {
			accessKeyId: input.accessKeyId,
			backupKeep: input.backupKeep ?? null,
			bucket: input.bucket,
			capacityAlertPercent: DEFAULT_CAPACITY_ALERT_PERCENT,
			capacityAlertedAt: null,
			capacityCheckedAt: null,
			capacityError: null,
			capacityFreeBytes: null,
			capacityTotalBytes: null,
			capacityUsedBytes: null,
			createdAt: now,
			endpoint: input.endpoint,
			id: crypto.randomUUID(),
			name: input.name,
			region: input.region,
			secretAccessKeyEnc: encryptSecret(input.secretAccessKey),
			type: input.type,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(s3Destination).values(row);
		return new S3DestinationDTO(row);
	}

	/**
	 * Saves edited destination fields; a blank secret access key keeps the stored
	 * one, anything else is re-encrypted.
	 */
	async update(input: S3DestinationUpdateInput): Promise<void> {
		const { secretAccessKey, ...rest } = input;
		const patch = {
			...rest,
			...(secretAccessKey
				? { secretAccessKeyEnc: encryptSecret(secretAccessKey) }
				: {}),
		};
		await db
			.update(s3Destination)
			.set(patch)
			.where(eq(s3Destination.id, this.row.id));
		Object.assign(this.row, patch);
	}

	/** Every destination that isn't S3 (SFTP, SMB, WebDAV), whose free space Homerun watches. */
	static async listNonS3(): Promise<S3DestinationDTO[]> {
		const rows = await db
			.select()
			.from(s3Destination)
			.where(ne(s3Destination.type, "s3"));
		return rows.map((row) => new S3DestinationDTO(row));
	}

	/** Records a capacity check: the figures when it worked, the error otherwise, keeping the last good figures. */
	async recordCapacity(
		result: { capacity: Capacity } | { error: string },
		checkedAt = new Date(),
	): Promise<void> {
		const patch =
			"capacity" in result
				? {
						capacityCheckedAt: checkedAt,
						capacityError: null,
						capacityFreeBytes: result.capacity.freeBytes,
						capacityTotalBytes: result.capacity.totalBytes,
						capacityUsedBytes: result.capacity.usedBytes,
					}
				: { capacityCheckedAt: checkedAt, capacityError: result.error };
		await db
			.update(s3Destination)
			.set(patch)
			.where(eq(s3Destination.id, this.row.id));
		Object.assign(this.row, patch);
	}

	/** Marks the low-space alert as sent (a date) or cleared (null). */
	async setCapacityAlerted(at: Date | null): Promise<void> {
		await db
			.update(s3Destination)
			.set({ capacityAlertedAt: at })
			.where(eq(s3Destination.id, this.row.id));
		this.row.capacityAlertedAt = at;
	}

	/** Sets the usage, in percent, past which the destination alerts, and lets it alert again. */
	async setCapacityAlertPercent(percent: number): Promise<void> {
		await db
			.update(s3Destination)
			.set({ capacityAlertedAt: null, capacityAlertPercent: percent })
			.where(eq(s3Destination.id, this.row.id));
		this.row.capacityAlertPercent = percent;
		this.row.capacityAlertedAt = null;
	}

	/** How many of each volume's newest backups are kept here, null to keep them all. */
	get backupKeep(): number | null {
		return this.row.backupKeep;
	}

	/** The last capacity measurement, null before the first successful check. */
	get capacity(): Capacity | null {
		const { capacityFreeBytes, capacityTotalBytes, capacityUsedBytes } =
			this.row;
		return capacityFreeBytes === null ||
			capacityTotalBytes === null ||
			capacityUsedBytes === null
			? null
			: {
					freeBytes: capacityFreeBytes,
					totalBytes: capacityTotalBytes,
					usedBytes: capacityUsedBytes,
				};
	}

	/** Deletes this destination row. */
	async delete(): Promise<void> {
		await db.delete(s3Destination).where(eq(s3Destination.id, this.row.id));
	}

	/** The destination's id. */
	get id(): string {
		return this.row.id;
	}
	/** The destination's display name. */
	get name(): string {
		return this.row.name;
	}
	/** Which protocol the destination speaks. */
	get type(): DestinationType {
		return this.row.type;
	}
	/** The S3-compatible endpoint URL, or a non-S3 destination's host or URL. */
	get endpoint(): string {
		return this.row.endpoint;
	}
	/** The bucket backups are uploaded to, or a non-S3 destination's path. */
	get bucket(): string {
		return this.row.bucket;
	}
	/** The bucket's region. */
	get region(): string {
		return this.row.region;
	}
	/** The access key id, or a non-S3 destination's username (not secret). */
	get accessKeyId(): string {
		return this.row.accessKeyId;
	}

	/** Decrypted secret access key, password or private key, for the backup client only : never exposed to a `load` return value. */
	decryptSecretAccessKey(): string {
		return decryptSecret(this.row.secretAccessKeyEnc) ?? "";
	}
}
