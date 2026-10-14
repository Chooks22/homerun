import { and, asc, eq } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import {
	type WorkstationPreset,
	workstationPreset,
} from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export type WorkstationPresetInput = Pick<
	WorkstationPreset,
	| "authAllowedEmails"
	| "authAllowedGroups"
	| "authAllowedUserIds"
	| "authProviders"
	| "authRequired"
	| "cpuLimit"
	| "description"
	| "editorSettings"
	| "env"
	| "extensions"
	| "gitAuthorEmail"
	| "gitAuthorName"
	| "gitBranch"
	| "gitProviderId"
	| "gitUrl"
	| "homePath"
	| "image"
	| "memoryLimitMb"
	| "name"
	| "port"
	| "remoteHostId"
>;

/**
 * Wraps the `workstation_preset` table: saved workstation settings a new
 * workstation can start from. Personal like workstations, so every finder
 * takes the owner's `userId`.
 */
export class WorkstationPresetDTO extends BaseDTO<WorkstationPreset> {
	/** Loads one of `userId`'s presets; null when missing or someone else's. */
	static async get(
		id: string,
		userId: string,
	): Promise<WorkstationPresetDTO | null> {
		const [row] = await db
			.select()
			.from(workstationPreset)
			.where(
				and(eq(workstationPreset.id, id), eq(workstationPreset.userId, userId)),
			)
			.limit(1);
		return row ? new WorkstationPresetDTO(row) : null;
	}

	/** Every preset `userId` owns, by name. */
	static async listForUser(userId: string): Promise<WorkstationPresetDTO[]> {
		const rows = await db
			.select()
			.from(workstationPreset)
			.where(eq(workstationPreset.userId, userId))
			.orderBy(asc(workstationPreset.name));
		return rows.map((row) => new WorkstationPresetDTO(row));
	}

	/** Inserts a new preset owned by `userId`. */
	static async create(
		userId: string,
		input: WorkstationPresetInput,
	): Promise<WorkstationPresetDTO> {
		const now = new Date();
		const row: WorkstationPreset = {
			...input,
			createdAt: now,
			id: crypto.randomUUID(),
			updatedAt: now,
			userId,
		};
		await db.insert(workstationPreset).values(row);
		return new WorkstationPresetDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: Partial<WorkstationPresetInput>): Promise<void> {
		await db
			.update(workstationPreset)
			.set(input)
			.where(eq(workstationPreset.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Deletes the preset. Workstations created from it keep their own copy of its settings. */
	async delete(): Promise<void> {
		await db
			.delete(workstationPreset)
			.where(eq(workstationPreset.id, this.row.id));
	}

	/** The preset's id. */
	get id(): string {
		return this.row.id;
	}
	/** Its display name. */
	get name(): string {
		return this.row.name;
	}
}
