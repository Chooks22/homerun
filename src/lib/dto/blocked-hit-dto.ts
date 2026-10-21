import {
	and,
	count,
	countDistinct,
	desc,
	eq,
	gte,
	isNotNull,
	lt,
	max,
	sql,
	sum,
} from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type BlockedHit, blockedHit } from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

/** One address's blocked requests within a window, newest first. */
export interface BlockedAddress {
	hits: number;
	host: string | null;
	ip: string;
	lastAt: Date;
	path: string | null;
}

/** What blocked requests added up to within a window. */
export interface BlockedSummary {
	addresses: number;
	baitBytes: number;
	baitResponses: number;
	requests: number;
	topPattern: { hits: number; pattern: string } | null;
}

/** Wraps the `blocked_hit` table: one row per request a service's blocked paths turned away, counted towards an IP ban. */
export class BlockedHitDTO extends BaseDTO<BlockedHit> {
	/**
	 * Records one blocked request, with the service and blocked-path pattern
	 * it hit and how many bytes of bait it was answered with.
	 */
	static async record(input: {
		baitBytes: number;
		host: string | null;
		ip: string;
		path: string | null;
		pattern: string | null;
		serviceId: string | null;
	}): Promise<void> {
		await db.insert(blockedHit).values({ ...input, createdAt: new Date() });
	}

	/** How many blocked requests `ip` made since `since`. */
	static async countSince(ip: string, since: Date): Promise<number> {
		const [row] = await db
			.select({ total: count() })
			.from(blockedHit)
			.where(and(eq(blockedHit.ip, ip), gte(blockedHit.createdAt, since)));
		return row?.total ?? 0;
	}

	/** Deletes every hit older than `before`. */
	static async deleteBefore(before: Date): Promise<void> {
		await db.delete(blockedHit).where(lt(blockedHit.createdAt, before));
	}

	/**
	 * Every address with blocked requests since `since`, with how many, when
	 * the last one came and the host and path it asked for, most recent first.
	 */
	static async addressesSince(
		since: Date,
		limit = 100,
		serviceId: string | null = null,
	): Promise<BlockedAddress[]> {
		const lastAt = max(blockedHit.createdAt);
		const rows = await db
			.select({
				hits: count(),
				host: sql<
					string | null
				>`(array_agg(${blockedHit.host} order by ${blockedHit.createdAt} desc))[1]`,
				ip: blockedHit.ip,
				lastAt,
				path: sql<
					string | null
				>`(array_agg(${blockedHit.path} order by ${blockedHit.createdAt} desc))[1]`,
			})
			.from(blockedHit)
			.where(BlockedHitDTO.#window(since, serviceId))
			.groupBy(blockedHit.ip)
			.orderBy(desc(lastAt))
			.limit(limit);
		return rows.map((row) => ({ ...row, lastAt: row.lastAt ?? since }));
	}

	/**
	 * How many addresses and requests were blocked since `since`, the
	 * blocked-path pattern hit most and the bait served, across every service
	 * or only `serviceId`'s.
	 */
	static async summarySince(
		since: Date,
		serviceId: string | null = null,
	): Promise<BlockedSummary> {
		const where = BlockedHitDTO.#window(since, serviceId);
		const hits = count();
		const [[totals], [top]] = await Promise.all([
			db
				.select({
					addresses: countDistinct(blockedHit.ip),
					baitBytes: sum(blockedHit.baitBytes).mapWith(Number),
					baitResponses: count(
						sql`case when ${blockedHit.baitBytes} > 0 then 1 end`,
					),
					requests: count(),
				})
				.from(blockedHit)
				.where(where),
			db
				.select({ hits, pattern: blockedHit.pattern })
				.from(blockedHit)
				.where(and(where, isNotNull(blockedHit.pattern)))
				.groupBy(blockedHit.pattern)
				.orderBy(desc(hits))
				.limit(1),
		]);
		return {
			addresses: totals?.addresses ?? 0,
			baitBytes: totals?.baitBytes ?? 0,
			baitResponses: totals?.baitResponses ?? 0,
			requests: totals?.requests ?? 0,
			topPattern: top?.pattern
				? { hits: top.hits, pattern: top.pattern }
				: null,
		};
	}

	/** Hits since `since`, on `serviceId` alone when it's set. */
	static #window(since: Date, serviceId: string | null) {
		return serviceId
			? and(
					gte(blockedHit.createdAt, since),
					eq(blockedHit.serviceId, serviceId),
				)
			: gte(blockedHit.createdAt, since);
	}
}
