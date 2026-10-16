import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	type SQL,
	sql,
} from "drizzle-orm";
import type { PipelineJob, PipelineStatus } from "#lib/pipelines/types.js";
import { db } from "#lib/server/db/lib.js";
import { type PipelineRun, pipelineRun } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { BaseDTO } from "./base-dto";

export type NewPipelineRun = Omit<
	PipelineRun,
	"id" | "traceExported" | "updatedAt"
>;

export interface PipelineStats {
	avgQueueMs: number | null;
	billableMinutes: number;
	costUsd: number;
	failed: number;
	name: string | null;
	p50Ms: number | null;
	p95Ms: number | null;
	runs: number;
	succeeded: number;
}

export interface KnownRun {
	attempt: number;
	status: PipelineStatus;
}

const aggregates = {
	avgQueueMs: sql<number | null>`avg(${pipelineRun.queueMs})::float8`,
	billableMinutes: sql<number>`coalesce(sum(${pipelineRun.billableMinutes}), 0)::int`,
	costUsd: sql<number>`coalesce(sum(${pipelineRun.costUsd}), 0)::float8`,
	failed: sql<number>`count(*) filter (where ${pipelineRun.status} = 'failure')::int`,
	p50Ms: sql<
		number | null
	>`percentile_cont(0.5) within group (order by ${pipelineRun.durationMs})::float8`,
	p95Ms: sql<
		number | null
	>`percentile_cont(0.95) within group (order by ${pipelineRun.durationMs})::float8`,
	runs: count(),
	succeeded: sql<number>`count(*) filter (where ${pipelineRun.status} = 'success')::int`,
};

function windowOf(serviceId: string, since: Date | null): SQL | undefined {
	return and(
		eq(pipelineRun.serviceId, serviceId),
		since ? gte(pipelineRun.createdAt, since) : undefined,
	);
}

/**
 * Wraps the `pipeline_run` table: one CI run (GitHub Actions workflow run,
 * GitLab pipeline, Gitea Actions run) of a service's repo, with its jobs and
 * steps as JSON, its timings and its cost at the service's runner rates.
 */
export class PipelineRunDTO extends BaseDTO<PipelineRun> {
	/** What's already stored of the given provider run ids for a service, keyed by run id, to tell which runs need their jobs read again. */
	static async known(
		serviceId: string,
		externalIds: string[],
	): Promise<Map<string, KnownRun>> {
		if (externalIds.length === 0) {
			return new Map();
		}
		const rows = await db
			.select({
				attempt: pipelineRun.attempt,
				externalId: pipelineRun.externalId,
				status: pipelineRun.status,
			})
			.from(pipelineRun)
			.where(
				and(
					eq(pipelineRun.serviceId, serviceId),
					inArray(pipelineRun.externalId, externalIds),
				),
			);
		return new Map(
			rows.map((row) => [
				row.externalId,
				{ attempt: row.attempt, status: row.status },
			]),
		);
	}

	/** Inserts a run or replaces what was stored of it, marking its trace as not exported yet so the new state gets exported. */
	static async upsert(input: NewPipelineRun): Promise<void> {
		await db
			.insert(pipelineRun)
			.values({ ...input, id: crypto.randomUUID() })
			.onConflictDoUpdate({
				set: { ...input, traceExported: false },
				target: [pipelineRun.serviceId, pipelineRun.externalId],
			});
	}

	/** Finished runs of a service whose trace hasn't been exported yet, oldest first, at most `limit`. */
	static async listUnexported(
		serviceId: string,
		limit = 50,
	): Promise<PipelineRunDTO[]> {
		const rows = await db
			.select()
			.from(pipelineRun)
			.where(
				and(
					eq(pipelineRun.serviceId, serviceId),
					eq(pipelineRun.traceExported, false),
					isNotNull(pipelineRun.finishedAt),
				),
			)
			.orderBy(pipelineRun.createdAt)
			.limit(limit);
		return rows.map((row) => new PipelineRunDTO(row));
	}

	/** Records that this run's trace went out, under `traceId`. */
	async markExported(traceId: string): Promise<void> {
		await db
			.update(pipelineRun)
			.set({ traceExported: true, traceId })
			.where(eq(pipelineRun.id, this.row.id));
		this.row.traceExported = true;
		this.row.traceId = traceId;
	}

	/**
	 * One page of a service's runs, newest first unless sorted otherwise.
	 * `q` matches the workflow name, branch, commit title or SHA; the
	 * `status` filter keeps the given statuses.
	 */
	static async list(
		serviceId: string,
		query: ListQuery,
	): Promise<PagedResult<PipelineRun>> {
		const statuses = query.filters.status ?? [];
		const where = and(
			eq(pipelineRun.serviceId, serviceId),
			searchCondition(query.q, [
				pipelineRun.name,
				pipelineRun.branch,
				pipelineRun.title,
				pipelineRun.commitSha,
			]),
			statuses.length
				? inArray(pipelineRun.status, statuses as PipelineStatus[])
				: undefined,
		);
		const [items, [{ total }]] = await Promise.all([
			db
				.select()
				.from(pipelineRun)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							cost: pipelineRun.costUsd,
							created: pipelineRun.createdAt,
							duration: pipelineRun.durationMs,
							name: pipelineRun.name,
						},
						desc(pipelineRun.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(pipelineRun).where(where),
		]);
		return { items, page: query.page, perPage: query.perPage, total };
	}

	/** Totals over a service's runs since `since` (all of them when null): counts, success and failure, p50/p95 duration, mean queue time, billable minutes and cost. */
	static async stats(
		serviceId: string,
		since: Date | null,
	): Promise<PipelineStats> {
		const [row] = await db
			.select(aggregates)
			.from(pipelineRun)
			.where(windowOf(serviceId, since));
		return { ...row, name: null };
	}

	/** The same totals per workflow name since `since`, busiest first. */
	static async byWorkflow(
		serviceId: string,
		since: Date | null,
	): Promise<PipelineStats[]> {
		return await db
			.select({ ...aggregates, name: pipelineRun.name })
			.from(pipelineRun)
			.where(windowOf(serviceId, since))
			.groupBy(pipelineRun.name)
			.orderBy(desc(count()));
	}

	/** Every run of a service with what re-costing it needs. */
	static async listForService(serviceId: string): Promise<PipelineRunDTO[]> {
		const rows = await db
			.select()
			.from(pipelineRun)
			.where(eq(pipelineRun.serviceId, serviceId));
		return rows.map((row) => new PipelineRunDTO(row));
	}

	/** Replaces the run's jobs and total cost after its rates changed. */
	async setCost(costUsd: number, jobs: PipelineJob[]): Promise<void> {
		await db
			.update(pipelineRun)
			.set({ costUsd, jobs })
			.where(eq(pipelineRun.id, this.row.id));
		this.row.costUsd = costUsd;
		this.row.jobs = jobs;
	}
}
