import {
	and,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	type SQL,
} from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type Workstation, workstation } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	narrowFilter,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { decryptSecret } from "#lib/services/secrets.js";
import { BaseDTO } from "./base-dto";

export type NewWorkstationInput = Pick<
	Workstation,
	| "cpuLimit"
	| "env"
	| "gitBranch"
	| "gitUrl"
	| "homePath"
	| "image"
	| "memoryLimitMb"
	| "name"
	| "passwordEnc"
	| "port"
	| "remoteHostId"
	| "slug"
	| "userId"
>;

export type WorkstationUpdateInput = Partial<
	Pick<
		Workstation,
		| "autoStopAt"
		| "autoStopMinutes"
		| "autoStopMode"
		| "cpuLimit"
		| "desiredState"
		| "env"
		| "gitBranch"
		| "gitUrl"
		| "homePath"
		| "image"
		| "lastError"
		| "memoryLimitMb"
		| "name"
		| "passwordEnc"
		| "port"
	>
>;

/**
 * Wraps the `workstation` table. Workstations are personal: every finder
 * takes the owner's `userId`, unlike the shared resources.
 */
export class WorkstationDTO extends BaseDTO<Workstation> {
	/** Loads one of `userId`'s workstations; null when missing or someone else's. */
	static async get(id: string, userId: string): Promise<WorkstationDTO | null> {
		const [row] = await db
			.select()
			.from(workstation)
			.where(and(eq(workstation.id, id), eq(workstation.userId, userId)))
			.limit(1);
		return row ? new WorkstationDTO(row) : null;
	}

	/** Every workstation `userId` owns, newest first. */
	static async listForUser(userId: string): Promise<WorkstationDTO[]> {
		const rows = await db
			.select()
			.from(workstation)
			.where(eq(workstation.userId, userId))
			.orderBy(desc(workstation.createdAt));
		return rows.map((row) => new WorkstationDTO(row));
	}

	/** One page of `userId`'s workstations, searched and filtered server-side, plus the unpaged total. */
	static async listPaged(
		userId: string,
		query: ListQuery,
	): Promise<PagedResult<WorkstationDTO>> {
		const conditions: SQL[] = [eq(workstation.userId, userId)];
		const search = searchCondition(query.q, [
			workstation.name,
			workstation.slug,
			workstation.image,
			workstation.gitUrl,
		]);
		if (search) {
			conditions.push(search);
		}
		const states = narrowFilter(query.filters.state, [
			"running",
			"stopped",
		] as const);
		if (states.length > 0) {
			conditions.push(inArray(workstation.desiredState, states));
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(workstation)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: workstation.createdAt,
							name: workstation.name,
							updated: workstation.updatedAt,
						},
						desc(workstation.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(workstation).where(where),
		]);

		return {
			items: rows.map((row) => new WorkstationDTO(row)),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/** Every workstation, anyone's, that should be running with an auto-stop set, for the auto-stop scheduler. */
	static async listAutoStopping(): Promise<WorkstationDTO[]> {
		const rows = await db
			.select()
			.from(workstation)
			.where(
				and(
					eq(workstation.desiredState, "running"),
					isNotNull(workstation.autoStopMode),
				),
			);
		return rows.map((row) => new WorkstationDTO(row));
	}

	/** Whether any workstation, anyone's, already uses `slug`. */
	static async slugTaken(slug: string): Promise<boolean> {
		const [row] = await db
			.select({ id: workstation.id })
			.from(workstation)
			.where(eq(workstation.slug, slug))
			.limit(1);
		return !!row;
	}

	/** Inserts a new workstation, stopped. The password must already be encrypted. */
	static async create(input: NewWorkstationInput): Promise<WorkstationDTO> {
		const now = new Date();
		const row: Workstation = {
			...input,
			autoStopAt: null,
			autoStopMinutes: null,
			autoStopMode: null,
			createdAt: now,
			desiredState: "stopped",
			id: crypto.randomUUID(),
			lastError: null,
			updatedAt: now,
		};
		await db.insert(workstation).values(row);
		return new WorkstationDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: WorkstationUpdateInput): Promise<void> {
		await db
			.update(workstation)
			.set(input)
			.where(eq(workstation.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Row-only delete: the container and its volume are `WorkstationService.remove`'s job. */
	async delete(): Promise<void> {
		await db.delete(workstation).where(eq(workstation.id, this.row.id));
	}

	/** The IDE password, decrypted; null when it can't be. */
	password(): string | null {
		return decryptSecret(this.row.passwordEnc);
	}

	/** The row without the encrypted password, for handing to a page. */
	toPublic(): Omit<Workstation, "passwordEnc"> {
		const { passwordEnc: _passwordEnc, ...rest } = this.row;
		return rest;
	}

	/** The workstation's id. */
	get id(): string {
		return this.row.id;
	}
	/** Its display name. */
	get name(): string {
		return this.row.name;
	}
	/** Its DNS-safe slug, the first label of its hostname. */
	get slug(): string {
		return this.row.slug;
	}
	/** Who owns it. */
	get userId(): string {
		return this.row.userId;
	}
	/** The agent-mode host it runs on, null for this server. */
	get remoteHostId(): string | null {
		return this.row.remoteHostId;
	}
	/** Whether the owner last asked for it running or stopped. */
	get desiredState(): Workstation["desiredState"] {
		return this.row.desiredState;
	}
}
