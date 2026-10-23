import { and, count, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { job } from "#lib/server/db/schema.js";

/**
 * Reserves a build server for job `jobId`: under a transaction-scoped
 * advisory lock, so two deploys never take the last slot at once, counts
 * the running jobs holding each build server, asks `choose` for one and
 * records it on the job. The slot frees once the job stops running.
 *
 * @returns The reserved host id, or null when `choose` found none free.
 */
export async function reserveBuildHost(
	jobId: string,
	choose: (active: Map<string, number>) => string | null,
): Promise<string | null> {
	return await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('homerun:build-slots'))`,
		);
		const rows = await tx
			.select({ hostId: job.buildHostId, total: count() })
			.from(job)
			.where(
				and(
					eq(job.status, "running"),
					ne(job.id, jobId),
					isNotNull(job.buildHostId),
				),
			)
			.groupBy(job.buildHostId);
		const active = new Map(
			rows.flatMap((r) => (r.hostId ? [[r.hostId, r.total] as const] : [])),
		);
		const chosen = choose(active);
		if (chosen) {
			await tx
				.update(job)
				.set({ buildHostId: chosen })
				.where(eq(job.id, jobId));
		}
		return chosen;
	});
}
