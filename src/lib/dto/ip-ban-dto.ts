import {
	and,
	asc,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	lte,
	or,
} from "drizzle-orm";
import type { IpIntel } from "#lib/ip-intel.js";
import { db } from "#lib/server/db/lib.js";
import { type IpBan, ipBan } from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

/** Wraps the `ip_ban` table: one row per banned client address, enforced by Traefik through `IpBanService`. */
export class IpBanDTO extends BaseDTO<IpBan> {
	/** Every ban still in force at `now`, newest first. */
	static async listActive(now = new Date()): Promise<IpBanDTO[]> {
		const rows = await db
			.select()
			.from(ipBan)
			.where(or(isNull(ipBan.expiresAt), gt(ipBan.expiresAt, now)))
			.orderBy(desc(ipBan.createdAt));
		return rows.map((row) => new IpBanDTO(row));
	}

	/** Every banned address still in force at `now`, oldest ban first, for the Traefik rule. */
	static async activeIps(now = new Date()): Promise<string[]> {
		const rows = await db
			.select({ ip: ipBan.ip })
			.from(ipBan)
			.where(or(isNull(ipBan.expiresAt), gt(ipBan.expiresAt, now)))
			.orderBy(asc(ipBan.createdAt));
		return rows.map((row) => row.ip);
	}

	/** Whether `ip` has a ban in force at `now`. */
	static async isBanned(ip: string, now = new Date()): Promise<boolean> {
		const [row] = await db
			.select({ ip: ipBan.ip })
			.from(ipBan)
			.where(
				and(
					eq(ipBan.ip, ip),
					or(isNull(ipBan.expiresAt), gt(ipBan.expiresAt, now)),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	/** Bans `ip`, or replaces its expired ban; does nothing when it's already banned. Returns whether a ban was written. */
	static async ban(input: {
		expiresAt: Date | null;
		host: string | null;
		ip: string;
		reason: string;
		userAgent: string | null;
	}): Promise<boolean> {
		const now = new Date();
		const written = await db
			.insert(ipBan)
			.values({ ...input, createdAt: now })
			.onConflictDoUpdate({
				set: { ...input, createdAt: now },
				setWhere: and(isNotNull(ipBan.expiresAt), lte(ipBan.expiresAt, now)),
				target: ipBan.ip,
			})
			.returning({ ip: ipBan.ip });
		return written.length > 0;
	}

	/** Stores what a lookup found out about `ip`'s ban. */
	static async setIntel(ip: string, intel: IpIntel): Promise<void> {
		await db.update(ipBan).set({ intel }).where(eq(ipBan.ip, ip));
	}

	/** Addresses banned at `now` that haven't been looked up yet, oldest ban first, at most `limit`. */
	static async unidentifiedIps(
		limit: number,
		now = new Date(),
	): Promise<string[]> {
		const rows = await db
			.select({ ip: ipBan.ip })
			.from(ipBan)
			.where(
				and(
					isNull(ipBan.intel),
					or(isNull(ipBan.expiresAt), gt(ipBan.expiresAt, now)),
				),
			)
			.orderBy(asc(ipBan.createdAt))
			.limit(limit);
		return rows.map((row) => row.ip);
	}

	/** Lifts the ban on `ip`. Returns whether there was one. */
	static async unban(ip: string): Promise<boolean> {
		const removed = await db
			.delete(ipBan)
			.where(eq(ipBan.ip, ip))
			.returning({ ip: ipBan.ip });
		return removed.length > 0;
	}

	/** Deletes every ban that ended by `now`. Returns how many went. */
	static async deleteExpired(now = new Date()): Promise<number> {
		const removed = await db
			.delete(ipBan)
			.where(and(isNotNull(ipBan.expiresAt), lte(ipBan.expiresAt, now)))
			.returning({ ip: ipBan.ip });
		return removed.length;
	}
}
