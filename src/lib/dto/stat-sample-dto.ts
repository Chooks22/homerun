import { and, desc, eq, gte, inArray, isNull, lt, min, sql } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type StatSample, statSample } from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export type StatRange =
	| "live"
	| "hour"
	| "day"
	| "week"
	| "month"
	| "year"
	| "all";

export interface StatPoint {
	at: Date;
	cpuPercent: number;
	memUsedMb: number;
	netRxBytesPerSec: number;
	netTxBytesPerSec: number;
}

/** A service's resource use over a range. */
export interface ResourceTotals {
	avgCpuPercent: number | null;
	avgMemUsedMb: number | null;
	memLimitMb: number | null;
	peakCpuPercent: number | null;
	peakMemUsedMb: number | null;
}

/** Whose resource use a query sums: some services, or the host itself. */
export type ResourceScope = { serviceIds: string[] } | "host";

/** A service's average CPU and memory over a range, for a breakdown table. */
export interface ServiceResourceAverages {
	avgCpuPercent: number;
	avgMemUsedMb: number;
}

/** One chart bucket of resource use. */
export interface ResourcePoint {
	at: Date;
	cpuPercent: number;
	memUsedMb: number;
}

export interface NewStatSampleInput {
	cpuPercent: number;
	diskUsedGb?: number | null;
	memLimitMb?: number | null;
	memUsedMb: number;
	netRxBytes?: number | null;
	netTxBytes?: number | null;
	serviceId: string | null;
	workstationId?: string | null;
}

/** Whose history a chart reads: a service, a workstation, or the host (null). */
export type StatOwner = string | { workstationId: string } | null;

/** The host's own samples: neither a service's nor a workstation's. */
const hostRows = () =>
	and(isNull(statSample.serviceId), isNull(statSample.workstationId));

/**
 * How far back each range looks and how wide one bucket is. The point count
 * per range stays in the 60-360 band on purpose : enough resolution for the
 * chart's width, few enough rows to aggregate without paging.
 */
const RANGES: Record<
	StatRange,
	{ bucketSeconds: number; windowSeconds: number | null }
> = {
	all: { bucketSeconds: 86_400, windowSeconds: null },
	day: { bucketSeconds: 300, windowSeconds: 86_400 },
	hour: { bucketSeconds: 60, windowSeconds: 3600 },
	live: { bucketSeconds: 60, windowSeconds: 900 },
	month: { bucketSeconds: 7200, windowSeconds: 2_592_000 },
	week: { bucketSeconds: 1800, windowSeconds: 604_800 },
	year: { bucketSeconds: 86_400, windowSeconds: 31_536_000 },
};

/** Samples older than this are pruned by the sampler : a year of minute samples is the retention ceiling. */
const RETENTION_SECONDS = 31_536_000;

/** The samples a scope covers from `since` on (all of them when null) and before `until` when set; null when the scope is no services at all. */
function scopeFilter(
	scope: ResourceScope,
	since: Date | null,
	until: Date | null = null,
) {
	if (scope !== "host" && scope.serviceIds.length === 0) {
		return null;
	}
	const who =
		scope === "host"
			? hostRows()
			: inArray(statSample.serviceId, scope.serviceIds);
	return and(
		who,
		since ? gte(statSample.createdAt, since) : undefined,
		until ? lt(statSample.createdAt, until) : undefined,
	);
}

/**
 * One row per sampler tick summing the scope's samples: every row of a tick
 * carries the same timestamp, so the sum is the scope's use at that minute.
 */
function ticks(filter: NonNullable<ReturnType<typeof scopeFilter>>) {
	return db
		.select({
			at: statSample.createdAt,
			cpu: sql<number>`sum(${statSample.cpuPercent})`.as("cpu"),
			limit: sql<number | null>`sum(${statSample.memLimitMb})`.as("mem_limit"),
			mem: sql<number>`sum(${statSample.memUsedMb})`.as("mem"),
		})
		.from(statSample)
		.where(filter)
		.groupBy(statSample.createdAt)
		.as("ticks");
}

const NO_RESOURCES: ResourceTotals = {
	avgCpuPercent: null,
	avgMemUsedMb: null,
	memLimitMb: null,
	peakCpuPercent: null,
	peakMemUsedMb: null,
};

/** Wraps `stat_sample` : the resource history behind the dashboard's and a service's own graphs. */
export class StatSampleDTO extends BaseDTO<StatSample> {
	/**
	 * Inserts one resource sample, stamped now; with neither a `serviceId` nor
	 * a `workstationId` it's a host-wide sample.
	 */
	static async record(input: NewStatSampleInput): Promise<void> {
		await db.insert(statSample).values({
			cpuPercent: input.cpuPercent,
			createdAt: new Date(),
			diskUsedGb: input.diskUsedGb ?? null,
			id: crypto.randomUUID(),
			memLimitMb: input.memLimitMb ?? null,
			memUsedMb: input.memUsedMb,
			netRxBytes: input.netRxBytes ?? null,
			netTxBytes: input.netTxBytes ?? null,
			serviceId: input.serviceId,
			workstationId: input.workstationId ?? null,
		});
	}

	/**
	 * Inserts a batch of resource samples in one statement, all stamped with the
	 * same time.
	 */
	static async recordMany(inputs: NewStatSampleInput[]): Promise<void> {
		if (inputs.length === 0) {
			return;
		}
		const now = new Date();
		await db.insert(statSample).values(
			inputs.map((input) => ({
				cpuPercent: input.cpuPercent,
				createdAt: now,
				diskUsedGb: input.diskUsedGb ?? null,
				id: crypto.randomUUID(),
				memLimitMb: input.memLimitMb ?? null,
				memUsedMb: input.memUsedMb,
				netRxBytes: input.netRxBytes ?? null,
				netTxBytes: input.netTxBytes ?? null,
				serviceId: input.serviceId,
				workstationId: input.workstationId ?? null,
			})),
		);
	}

	/**
	 * One bucketed series for a range, averaging CPU/memory per bucket and
	 * turning the cumulative network counters into a per-second rate across
	 * it. The rate is clamped at zero because a container restart resets its
	 * own counters, which would otherwise read as a large negative spike.
	 */
	static async history(
		range: StatRange,
		owner: StatOwner,
	): Promise<StatPoint[]> {
		const { bucketSeconds, windowSeconds } = RANGES[range];
		const scope =
			owner === null
				? hostRows()
				: typeof owner === "string"
					? eq(statSample.serviceId, owner)
					: eq(statSample.workstationId, owner.workstationId);
		const where = windowSeconds
			? and(
					scope,
					gte(
						statSample.createdAt,
						new Date(Date.now() - windowSeconds * 1000),
					),
				)
			: scope;

		// The bucket width is inlined rather than bound: dividing by an
		// untyped bind parameter makes Postgres reject the expression as an
		// ambiguous operator. It's a constant from RANGES above, never user
		// input, so sql.raw is safe here.
		const bucket = sql<number>`floor(extract(epoch from ${statSample.createdAt}) / ${sql.raw(String(bucketSeconds))})`;
		const rows = await db
			.select({
				at: sql<number>`min(extract(epoch from ${statSample.createdAt}))`,
				bucket,
				cpuPercent: sql<number>`avg(${statSample.cpuPercent})`,
				memUsedMb: sql<number>`avg(${statSample.memUsedMb})`,
				rxRange: sql<number>`max(${statSample.netRxBytes}) - min(${statSample.netRxBytes})`,
				spanSeconds: sql<number>`greatest(extract(epoch from (max(${statSample.createdAt}) - min(${statSample.createdAt}))), 1)`,
				txRange: sql<number>`max(${statSample.netTxBytes}) - min(${statSample.netTxBytes})`,
			})
			.from(statSample)
			.where(where)
			.groupBy(bucket)
			.orderBy(bucket);

		return rows.map((row) => ({
			at: new Date(Number(row.at) * 1000),
			cpuPercent: Number(row.cpuPercent ?? 0),
			memUsedMb: Number(row.memUsedMb ?? 0),
			netRxBytesPerSec:
				Math.max(0, Number(row.rxRange ?? 0)) / Number(row.spanSeconds),
			netTxBytesPerSec:
				Math.max(0, Number(row.txRange ?? 0)) / Number(row.spanSeconds),
		}));
	}

	/** Average and peak CPU and memory of a scope from `since` on (all of its history when null), summed over its services each minute. */
	static async totals(
		scope: ResourceScope,
		since: Date | null,
		until: Date | null = null,
	): Promise<ResourceTotals> {
		const filter = scopeFilter(scope, since, until);
		if (!filter) {
			return NO_RESOURCES;
		}
		const sums = ticks(filter);
		const [row] = await db
			.select({
				avgCpu: sql<number | null>`avg(${sums.cpu})`,
				avgMem: sql<number | null>`avg(${sums.mem})`,
				limit: sql<number | null>`max(${sums.limit})`,
				peakCpu: sql<number | null>`max(${sums.cpu})`,
				peakMem: sql<number | null>`max(${sums.mem})`,
			})
			.from(sums);
		const numberOrNull = (value: unknown) =>
			value === null || value === undefined ? null : Number(value);
		return {
			avgCpuPercent: numberOrNull(row?.avgCpu),
			avgMemUsedMb: numberOrNull(row?.avgMem),
			memLimitMb: numberOrNull(row?.limit),
			peakCpuPercent: numberOrNull(row?.peakCpu),
			peakMemUsedMb: numberOrNull(row?.peakMem),
		};
	}

	/** A scope's CPU and memory per bucket from `since` on, averaging its per-minute sums; `bucketSeconds` inlined like `history`'s. */
	static async series(
		scope: ResourceScope,
		since: Date | null,
		bucketSeconds: number,
	): Promise<ResourcePoint[]> {
		const filter = scopeFilter(scope, since);
		if (!filter) {
			return [];
		}
		const sums = ticks(filter);
		const bucket = sql<number>`floor(extract(epoch from ${sums.at}) / ${sql.raw(String(Math.trunc(bucketSeconds)))})`;
		const rows = await db
			.select({
				bucket,
				cpuPercent: sql<number>`avg(${sums.cpu})`,
				memUsedMb: sql<number>`avg(${sums.mem})`,
			})
			.from(sums)
			.groupBy(bucket)
			.orderBy(bucket);
		return rows.map((row) => ({
			at: new Date(Number(row.bucket) * bucketSeconds * 1000),
			cpuPercent: Number(row.cpuPercent ?? 0),
			memUsedMb: Number(row.memUsedMb ?? 0),
		}));
	}

	/** Each service's average CPU and memory from `since` on, keyed by service id. */
	static async averagesByService(
		serviceIds: string[],
		since: Date | null,
	): Promise<Map<string, ServiceResourceAverages>> {
		const filter = scopeFilter({ serviceIds }, since);
		if (!filter) {
			return new Map();
		}
		const rows = await db
			.select({
				cpu: sql<number>`avg(${statSample.cpuPercent})`,
				mem: sql<number>`avg(${statSample.memUsedMb})`,
				serviceId: statSample.serviceId,
			})
			.from(statSample)
			.where(filter)
			.groupBy(statSample.serviceId);
		return new Map(
			rows.map((row) => [
				row.serviceId ?? "",
				{ avgCpuPercent: Number(row.cpu), avgMemUsedMb: Number(row.mem) },
			]),
		);
	}

	/** When a scope's first sample was written, null when it has none. */
	static async firstAt(scope: ResourceScope): Promise<Date | null> {
		const filter = scopeFilter(scope, null);
		if (!filter) {
			return null;
		}
		const [row] = await db
			.select({ first: min(statSample.createdAt) })
			.from(statSample)
			.where(filter);
		return row?.first ?? null;
	}

	/** The newest sample for every service that has one, for the dashboard's sortable usage table. */
	static async latestPerService(): Promise<Map<string, StatSample>> {
		const rows = await db
			.selectDistinctOn([statSample.serviceId])
			.from(statSample)
			.where(sql`${statSample.serviceId} is not null`)
			.orderBy(statSample.serviceId, desc(statSample.createdAt));
		return new Map(
			rows
				.filter((row) => row.serviceId)
				.map((row) => [row.serviceId as string, row]),
		);
	}

	/** The newest sample of each of `workstationIds` that has one, keyed by workstation id. */
	static async latestPerWorkstation(
		workstationIds: string[],
	): Promise<Map<string, StatSample>> {
		if (workstationIds.length === 0) {
			return new Map();
		}
		const rows = await db
			.selectDistinctOn([statSample.workstationId])
			.from(statSample)
			.where(inArray(statSample.workstationId, workstationIds))
			.orderBy(statSample.workstationId, desc(statSample.createdAt));
		return new Map(
			rows.flatMap((row) =>
				row.workstationId ? [[row.workstationId, row] as const] : [],
			),
		);
	}

	/** Deletes samples older than the one-year retention ceiling. */
	static async prune(): Promise<void> {
		await db
			.delete(statSample)
			.where(
				lt(
					statSample.createdAt,
					new Date(Date.now() - RETENTION_SECONDS * 1000),
				),
			);
	}
}
