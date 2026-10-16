import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import {
	type GitProviderKind,
	type Repository,
	repository,
	service,
} from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export type NewRepositoryInput = Pick<
	Repository,
	| "defaultBranch"
	| "fullName"
	| "providerId"
	| "providerKind"
	| "userId"
	| "webUrl"
>;

export type RepositoryUpdateInput = Partial<
	Pick<
		Repository,
		| "defaultBranch"
		| "pipelineRates"
		| "pipelinesEnabled"
		| "pipelinesError"
		| "pipelinesSyncedAt"
	>
>;

export interface LinkedService {
	id: string;
	name: string;
}

/**
 * Wraps the `repository` table: a repository on a connected git provider
 * that Homerun watches, read through the connection of the user who added
 * it. Its CI runs land in `pipeline_run`, and services link to it
 * (`service.repository_id`) for their Pipelines tab and error tracking's
 * links to source.
 */
export class RepositoryDTO extends BaseDTO<Repository> {
	/** Starts watching a repository, with syncing on and the provider's default rates. */
	static async create(input: NewRepositoryInput): Promise<RepositoryDTO> {
		const now = new Date();
		const row: Repository = {
			...input,
			createdAt: now,
			id: crypto.randomUUID(),
			pipelineRates: null,
			pipelinesEnabled: true,
			pipelinesError: null,
			pipelinesSyncedAt: null,
			updatedAt: now,
		};
		await db.insert(repository).values(row);
		return new RepositoryDTO(row);
	}

	/** Loads one watched repository by id; null when missing. */
	static async get(id: string): Promise<RepositoryDTO | null> {
		const [row] = await db
			.select()
			.from(repository)
			.where(eq(repository.id, id))
			.limit(1);
		return row ? new RepositoryDTO(row) : null;
	}

	/** The watched repository with this path on this provider; null when it isn't watched. */
	static async getByPath(
		providerId: string,
		fullName: string,
	): Promise<RepositoryDTO | null> {
		const [row] = await db
			.select()
			.from(repository)
			.where(
				and(
					eq(repository.providerId, providerId),
					eq(repository.fullName, fullName),
				),
			)
			.limit(1);
		return row ? new RepositoryDTO(row) : null;
	}

	/** Every watched repository, by name. */
	static async list(): Promise<RepositoryDTO[]> {
		const rows = await db
			.select()
			.from(repository)
			.orderBy(asc(repository.fullName));
		return rows.map((row) => new RepositoryDTO(row));
	}

	/** Every watched repository whose CI runs are synced. */
	static async listPipelinesEnabled(): Promise<RepositoryDTO[]> {
		const rows = await db
			.select()
			.from(repository)
			.where(eq(repository.pipelinesEnabled, true));
		return rows.map((row) => new RepositoryDTO(row));
	}

	/** The services linked to each watched repository, by name, keyed by repository id. */
	static async linkedServicesByRepository(): Promise<
		Map<string, LinkedService[]>
	> {
		const rows = await db
			.select({
				id: service.id,
				name: service.name,
				repositoryId: service.repositoryId,
			})
			.from(service)
			.orderBy(asc(service.name));
		const linked = new Map<string, LinkedService[]>();
		for (const row of rows) {
			if (row.repositoryId) {
				linked.set(row.repositoryId, [
					...(linked.get(row.repositoryId) ?? []),
					{ id: row.id, name: row.name },
				]);
			}
		}
		return linked;
	}

	/** The ids of the services building from this repository on this provider, so watching it can link them right away. */
	static async servicesBuildingFrom(
		providerId: string,
		fullName: string,
	): Promise<string[]> {
		const rows = await db
			.select({ id: service.id })
			.from(service)
			.where(
				and(
					eq(service.buildSource, "git"),
					eq(service.gitProviderId, providerId),
					eq(service.gitRepo, fullName),
				),
			);
		return rows.map((row) => row.id);
	}

	/** The services linked to this repository, by name. */
	async linkedServices(): Promise<LinkedService[]> {
		return await db
			.select({ id: service.id, name: service.name })
			.from(service)
			.where(eq(service.repositoryId, this.row.id))
			.orderBy(asc(service.name));
	}

	/** Links exactly `serviceIds` to this repository: unlinks the others linked to it, and moves each given service off whatever repository it was linked to before. */
	async setLinkedServices(serviceIds: string[]): Promise<void> {
		await db.transaction(async (tx) => {
			await tx
				.update(service)
				.set({ repositoryId: null })
				.where(
					serviceIds.length
						? and(
								eq(service.repositoryId, this.row.id),
								notInArray(service.id, serviceIds),
							)
						: eq(service.repositoryId, this.row.id),
				);
			if (serviceIds.length) {
				await tx
					.update(service)
					.set({ repositoryId: this.row.id })
					.where(inArray(service.id, serviceIds));
			}
		});
	}

	/** Saves changes to the repository's settings or sync state. */
	async update(input: RepositoryUpdateInput): Promise<void> {
		await db
			.update(repository)
			.set(input)
			.where(eq(repository.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Stops watching the repository: its runs go with it and its services are unlinked. */
	async delete(): Promise<void> {
		await db.delete(repository).where(eq(repository.id, this.row.id));
	}

	/** The repository's id. */
	get id(): string {
		return this.row.id;
	}

	/** The `owner/repo` (or GitLab `group/…/repo`) path on its provider. */
	get fullName(): string {
		return this.row.fullName;
	}

	/** The id of the git provider (from the instance's provider settings) it lives on. */
	get providerId(): string {
		return this.row.providerId;
	}

	/** The kind of that provider. */
	get providerKind(): GitProviderKind {
		return this.row.providerKind;
	}

	/** The user whose connection reads it. */
	get userId(): string {
		return this.row.userId;
	}

	/** Its page on the provider. */
	get webUrl(): string {
		return this.row.webUrl;
	}
}
