import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import {
	CRON_JOB_KINDS,
	type CronJobFile,
	type CronJobKind,
	type CronJobMount,
	type ScriptRuntime,
} from "#lib/cron-job-script.js";
import { db } from "#lib/server/db/lib.js";
import { type CronJob, cronJob } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { BaseDTO } from "./base-dto";

export interface NewCronJobInput {
	command?: string | null;
	description?: string | null;
	dockerSocket?: boolean;
	enabled: boolean;
	envVars: Record<string, string>;
	files?: CronJobFile[];
	image?: string | null;
	kind: CronJobKind;
	mounts?: CronJobMount[];
	name: string;
	registryPasswordEnc?: string | null;
	registryUrl?: string | null;
	registryUsername?: string | null;
	remoteHostId?: string | null;
	runAsUser?: string | null;
	runtime?: ScriptRuntime | null;
	schedule: string;
	secretEnvKeys?: string[];
	source?: string | null;
	tag?: string | null;
	timeoutSeconds: number;
	userId: string;
}

export type CronJobUpdateInput = Partial<
	Pick<
		CronJob,
		| "command"
		| "description"
		| "dockerSocket"
		| "enabled"
		| "envVars"
		| "files"
		| "image"
		| "kind"
		| "lastRunAt"
		| "mounts"
		| "name"
		| "registryPasswordEnc"
		| "registryUrl"
		| "registryUsername"
		| "remoteHostId"
		| "runAsUser"
		| "runtime"
		| "schedule"
		| "secretEnvKeys"
		| "source"
		| "tag"
		| "timeoutSeconds"
	>
>;

/**
 * Wraps the `cron_job` table : a user-defined scheduled job, a one-off
 * container from an image, inline source code run on a runtime image, or a
 * shell command run on the app host.
 */
export class CronJobDTO extends BaseDTO<CronJob> {
	/** Loads one cron job by id; null when missing. */
	static async get(id: string): Promise<CronJobDTO | null> {
		const [row] = await db
			.select()
			.from(cronJob)
			.where(eq(cronJob.id, id))
			.limit(1);
		return row ? new CronJobDTO(row) : null;
	}

	/** Every cron job on the instance, newest first. */
	static async list(): Promise<CronJobDTO[]> {
		const rows = await db
			.select()
			.from(cronJob)
			.orderBy(desc(cronJob.createdAt));
		return rows.map((row) => new CronJobDTO(row));
	}

	/**
	 * One page of `list`, searched and filtered by kind and enabled state
	 * server-side, plus the unpaged total.
	 */
	static async listPaged(query: ListQuery): Promise<PagedResult<CronJobDTO>> {
		const conditions: SQL[] = [];
		const search = searchCondition(query.q, [
			cronJob.name,
			cronJob.description,
			cronJob.image,
			cronJob.command,
		]);
		if (search) {
			conditions.push(search);
		}
		const kinds = query.filters.kind;
		if (kinds && kinds.length > 0) {
			conditions.push(
				inArray(
					cronJob.kind,
					kinds.filter((k): k is CronJobKind =>
						CRON_JOB_KINDS.some((kind) => kind === k),
					),
				),
			);
		}
		const enabled = query.filters.enabled;
		if (enabled && enabled.length === 1) {
			conditions.push(eq(cronJob.enabled, enabled[0] === "on"));
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(cronJob)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: cronJob.createdAt,
							name: cronJob.name,
							updated: cronJob.updatedAt,
						},
						desc(cronJob.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(cronJob).where(where),
		]);

		return {
			items: rows.map((row) => new CronJobDTO(row)),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/**
	 * Every enabled cron job across all users, for the scheduler to check which
	 * are due.
	 */
	static async listEnabled(): Promise<CronJobDTO[]> {
		const rows = await db
			.select()
			.from(cronJob)
			.where(eq(cronJob.enabled, true));
		return rows.map((row) => new CronJobDTO(row));
	}

	/**
	 * Up to `limit` cron jobs whose name, description, image or
	 * command matches `q`, newest first, for global search.
	 */
	static async search(q: string, limit: number): Promise<CronJobDTO[]> {
		const rows = await db
			.select()
			.from(cronJob)
			.where(
				searchCondition(q, [
					cronJob.name,
					cronJob.description,
					cronJob.image,
					cronJob.command,
				]),
			)
			.orderBy(desc(cronJob.createdAt))
			.limit(limit);
		return rows.map((row) => new CronJobDTO(row));
	}

	/**
	 * Inserts a new cron job, defaulting the tag to `latest` and leaving it
	 * never-run.
	 */
	static async create(input: NewCronJobInput): Promise<CronJobDTO> {
		const now = new Date();
		const row: CronJob = {
			command: input.command ?? null,
			createdAt: now,
			description: input.description ?? null,
			dockerSocket: input.dockerSocket ?? false,
			enabled: input.enabled,
			envVars: input.envVars,
			files: input.files ?? [],
			id: crypto.randomUUID(),
			image: input.image ?? null,
			kind: input.kind,
			lastRunAt: null,
			mounts: input.mounts ?? [],
			name: input.name,
			registryPasswordEnc: input.registryPasswordEnc ?? null,
			registryUrl: input.registryUrl ?? null,
			registryUsername: input.registryUsername ?? null,
			remoteHostId: input.remoteHostId ?? null,
			runAsUser: input.runAsUser ?? null,
			runtime: input.runtime ?? null,
			schedule: input.schedule,
			secretEnvKeys: input.secretEnvKeys ?? [],
			source: input.source ?? null,
			tag: input.tag ?? "latest",
			timeoutSeconds: input.timeoutSeconds,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(cronJob).values(row);
		return new CronJobDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: CronJobUpdateInput): Promise<void> {
		await db.update(cronJob).set(input).where(eq(cronJob.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Deletes this cron job row. */
	async delete(): Promise<void> {
		await db.delete(cronJob).where(eq(cronJob.id, this.row.id));
	}

	/** The cron job's id. */
	get id(): string {
		return this.row.id;
	}
	/** The id of the user who created the job. */
	get userId(): string {
		return this.row.userId;
	}
	/** The job's display name. */
	get name(): string {
		return this.row.name;
	}
	/** The daemon an image-kind job runs on, null for this host's own socket. */
	get remoteHostId(): string | null {
		return this.row.remoteHostId;
	}

	/**
	 * Whether the job runs a one-off container from an image, inline source on
	 * a runtime image, or a shell command on the app host.
	 */
	get kind(): CronJob["kind"] {
		return this.row.kind;
	}
	/** The job's cron expression. */
	get schedule(): string {
		return this.row.schedule;
	}
	/** Whether the scheduler should run the job. */
	get enabled(): boolean {
		return this.row.enabled;
	}
	/** When the job last started, null if it never has. */
	get lastRunAt(): Date | null {
		return this.row.lastRunAt;
	}
	/** The image an image-kind job runs, null for exec jobs. */
	get image(): string | null {
		return this.row.image;
	}
	/** The image tag an image-kind job runs. */
	get tag(): string | null {
		return this.row.tag;
	}
	/** The command the job runs, if one is set. */
	get command(): string | null {
		return this.row.command;
	}
	/** The job's environment variables, empty when none are stored. */
	get envVars(): Record<string, string> {
		return this.row.envVars ?? {};
	}
	/** Env var names the owner marked secret: masked in the dashboard and always redacted for AI agents, whatever their name. */
	get secretEnvKeys(): string[] {
		return this.row.secretEnvKeys;
	}
	/** The config files written into the job's container before it starts. */
	get files(): CronJobFile[] {
		return this.row.files;
	}
	/** The storage volumes mounted into the job's container. */
	get mounts(): CronJobMount[] {
		return this.row.mounts;
	}
	/** The user the job's container runs as, null for the image's own. */
	get runAsUser(): string | null {
		return this.row.runAsUser;
	}
	/** Whether the job's container gets the Docker socket. */
	get dockerSocket(): boolean {
		return this.row.dockerSocket;
	}
	/** The runtime a script-kind job's source runs on, null for other kinds. */
	get runtime(): ScriptRuntime | null {
		return this.row.runtime;
	}
	/** A script-kind job's source code, null for other kinds. */
	get source(): string | null {
		return this.row.source;
	}
	/** How long a run may take before it is killed. */
	get timeoutSeconds(): number {
		return this.row.timeoutSeconds;
	}
	/** The private registry to pull the job's image from, if any. */
	get registryUrl(): string | null {
		return this.row.registryUrl;
	}
	/** The username for the job's private registry, if any. */
	get registryUsername(): string | null {
		return this.row.registryUsername;
	}
	/**
	 * The encrypted registry password, still encrypted : decrypt it only for a
	 * pull.
	 */
	get registryPasswordEnc(): string | null {
		return this.row.registryPasswordEnc;
	}
}
