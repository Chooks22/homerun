import { and, eq } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import {
	type GitConnection,
	type GitProviderKind,
	gitConnection,
} from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export interface NewGitConnectionInput {
	accessTokenEnc: string;
	expiresAt?: Date | null;
	providerId: string;
	providerKind: GitProviderKind;
	providerUsername: string;
	refreshTokenEnc?: string | null;
	userId: string;
}

export type GitConnectionUpdateInput = Partial<
	Pick<
		GitConnection,
		"accessTokenEnc" | "expiresAt" | "providerUsername" | "refreshTokenEnc"
	>
>;

/** Wraps the `git_connection` table : one user's OAuth connection to one configured git provider, see schema.ts's docstring. */
export class GitConnectionDTO extends BaseDTO<GitConnection> {
	/** Every git provider connection the user has made. */
	static async listForUser(userId: string): Promise<GitConnectionDTO[]> {
		const rows = await db
			.select()
			.from(gitConnection)
			.where(eq(gitConnection.userId, userId));
		return rows.map((row) => new GitConnectionDTO(row));
	}

	/**
	 * The user's connection to one configured git provider, null when they
	 * haven't connected it.
	 */
	static async getForUserAndProvider(
		userId: string,
		providerId: string,
	): Promise<GitConnectionDTO | null> {
		const [row] = await db
			.select()
			.from(gitConnection)
			.where(
				and(
					eq(gitConnection.userId, userId),
					eq(gitConnection.providerId, providerId),
				),
			)
			.limit(1);
		return row ? new GitConnectionDTO(row) : null;
	}

	/** Creates a new connection, or replaces the existing one for this user+provider (reconnecting). */
	static async upsert(input: NewGitConnectionInput): Promise<GitConnectionDTO> {
		const existing = await GitConnectionDTO.getForUserAndProvider(
			input.userId,
			input.providerId,
		);
		if (existing) {
			await existing.update({
				accessTokenEnc: input.accessTokenEnc,
				expiresAt: input.expiresAt ?? null,
				providerUsername: input.providerUsername,
				refreshTokenEnc: input.refreshTokenEnc ?? null,
			});
			return existing;
		}

		const now = new Date();
		const row: GitConnection = {
			accessTokenEnc: input.accessTokenEnc,
			createdAt: now,
			expiresAt: input.expiresAt ?? null,
			id: crypto.randomUUID(),
			providerId: input.providerId,
			providerKind: input.providerKind,
			providerUsername: input.providerUsername,
			refreshTokenEnc: input.refreshTokenEnc ?? null,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(gitConnection).values(row);
		return new GitConnectionDTO(row);
	}

	/**
	 * Writes the given token/username fields to the row and mirrors them onto
	 * this instance.
	 */
	async update(input: GitConnectionUpdateInput): Promise<void> {
		await db
			.update(gitConnection)
			.set(input)
			.where(eq(gitConnection.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Deletes this connection row, disconnecting the user from the provider. */
	async delete(): Promise<void> {
		await db.delete(gitConnection).where(eq(gitConnection.id, this.row.id));
	}

	/** The connection's id. */
	get id(): string {
		return this.row.id;
	}
	/** The id of the configured git provider this connection belongs to. */
	get providerId(): string {
		return this.row.providerId;
	}
	/** Which kind of git host the provider is. */
	get providerKind(): GitProviderKind {
		return this.row.providerKind;
	}
	/** The user's account name on the git provider. */
	get providerUsername(): string {
		return this.row.providerUsername;
	}
	/** The encrypted OAuth access token, still encrypted. */
	get accessTokenEnc(): string {
		return this.row.accessTokenEnc;
	}
	/**
	 * The encrypted OAuth refresh token, null when the provider didn't issue one.
	 */
	get refreshTokenEnc(): string | null {
		return this.row.refreshTokenEnc;
	}
	/** When the user first connected this provider. */
	get createdAt(): Date {
		return this.row.createdAt;
	}
	/** When the connection last changed: a reconnect or a token refresh. */
	get updatedAt(): Date {
		return this.row.updatedAt;
	}
	/** When the access token expires, null when it doesn't. */
	get expiresAt(): Date | null {
		return this.row.expiresAt;
	}
}
