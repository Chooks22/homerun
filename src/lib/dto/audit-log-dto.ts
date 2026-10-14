import { desc, eq, lt } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type AuditLog, auditLog } from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export interface NewAuditLogInput {
	action: string;
	actorId: string;
	actorName: string;
	detail: string;
	ipAddress?: string | null;
	status?: number | null;
}

const MAX_ROWS = 20_000;
const PRUNE_PROBABILITY = 0.01;

/** Wraps the `audit_log` table: one row per use of a service account's API key, kept after the account is deleted. */
export class AuditLogDTO extends BaseDTO<AuditLog> {
	/** The newest entries across every actor, deleted accounts included. */
	static async listRecent(limit = 200): Promise<AuditLogDTO[]> {
		const rows = await db
			.select()
			.from(auditLog)
			.orderBy(desc(auditLog.createdAt))
			.limit(limit);
		return rows.map((row) => new AuditLogDTO(row));
	}

	/** The newest entries recorded for one actor. */
	static async listForActor(
		actorId: string,
		limit = 200,
	): Promise<AuditLogDTO[]> {
		const rows = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.actorId, actorId))
			.orderBy(desc(auditLog.createdAt))
			.limit(limit);
		return rows.map((row) => new AuditLogDTO(row));
	}

	/**
	 * Inserts one entry and, on roughly 1% of writes, prunes the table back
	 * down to its newest 20000 rows.
	 */
	static async create(input: NewAuditLogInput): Promise<AuditLogDTO> {
		const row: AuditLog = {
			action: input.action,
			actorId: input.actorId,
			actorName: input.actorName,
			createdAt: new Date(),
			detail: input.detail,
			id: crypto.randomUUID(),
			ipAddress: input.ipAddress ?? null,
			status: input.status ?? null,
		};
		await db.insert(auditLog).values(row);
		if (Math.random() < PRUNE_PROBABILITY) {
			await AuditLogDTO.prune();
		}
		return new AuditLogDTO(row);
	}

	/** Deletes everything past the newest MAX_ROWS entries. */
	static async prune(): Promise<void> {
		const [cutoff] = await db
			.select({ createdAt: auditLog.createdAt })
			.from(auditLog)
			.orderBy(desc(auditLog.createdAt))
			.limit(1)
			.offset(MAX_ROWS - 1);
		if (!cutoff) {
			return;
		}
		await db.delete(auditLog).where(lt(auditLog.createdAt, cutoff.createdAt));
	}
}
