import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { CLIENT_SECRET_MARKER } from "#lib/oidc-provider.js";
import {
	generateClientSecret,
	hashClientSecret,
} from "#lib/server/client-secret.js";
import { db } from "#lib/server/db/lib.js";
import {
	type OauthClientSecret,
	oauthClientSecret,
} from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

export type OauthClientSecretSummary = Omit<OauthClientSecret, "secretHash">;

/**
 * Wraps `oauth_client_secret`: a client can hold several secrets, each tied
 * to one of its environments, created and revoked independently so a secret
 * can be rotated without downtime. Only a hash is kept. A secret with no
 * environment is the short-lived one the admin "Test sign-in" mints.
 */
export class OauthClientSecretDTO extends BaseDTO<OauthClientSecret> {
	/** Every secret of a client, newest first. */
	static async listForClient(
		clientId: string,
	): Promise<OauthClientSecretDTO[]> {
		const rows = await db
			.select()
			.from(oauthClientSecret)
			.where(eq(oauthClientSecret.clientId, clientId))
			.orderBy(desc(oauthClientSecret.createdAt));
		return rows.map((row) => new OauthClientSecretDTO(row));
	}

	/** One secret of a client, null when it isn't that client's. */
	static async get(
		clientId: string,
		id: string,
	): Promise<OauthClientSecretDTO | null> {
		const [row] = await db
			.select()
			.from(oauthClientSecret)
			.where(
				and(
					eq(oauthClientSecret.clientId, clientId),
					eq(oauthClientSecret.id, id),
				),
			)
			.limit(1);
		return row ? new OauthClientSecretDTO(row) : null;
	}

	/**
	 * The unexpired secret of `clientId` matching `secret`, null when none
	 * does. Scoped to the client, so one app's secret never authenticates
	 * another.
	 */
	static async match(
		clientId: string,
		secret: string,
	): Promise<OauthClientSecretDTO | null> {
		const [row] = await db
			.select()
			.from(oauthClientSecret)
			.where(
				and(
					eq(oauthClientSecret.clientId, clientId),
					eq(oauthClientSecret.secretHash, hashClientSecret(secret)),
					or(
						isNull(oauthClientSecret.expiresAt),
						gt(oauthClientSecret.expiresAt, new Date()),
					),
				),
			)
			.limit(1);
		return row ? new OauthClientSecretDTO(row) : null;
	}

	/**
	 * better-auth's `storeClientSecret.verify`: `stored` is the client row's
	 * `client_secret`, which holds `homerun-secrets:<client id>` once the
	 * client's secrets live in this table, so the presented secret is checked
	 * against that client's secrets and marks the one that matched as used. A
	 * bare hash (a client registered before) is compared directly.
	 */
	static async verify(secret: string, stored: string): Promise<boolean> {
		if (stored.startsWith(CLIENT_SECRET_MARKER)) {
			const match = await OauthClientSecretDTO.match(
				stored.slice(CLIENT_SECRET_MARKER.length),
				secret,
			);
			await match?.touch();
			return match !== null;
		}
		const presented = Buffer.from(hashClientSecret(secret));
		const expected = Buffer.from(stored);
		return (
			presented.length === expected.length &&
			timingSafeEqual(presented, expected)
		);
	}

	/**
	 * Mints a new secret for a client's environment, or an expiring one with
	 * no environment for a test sign-in.
	 *
	 * @returns The plaintext secret, shown once, and its row.
	 */
	static async issue(
		clientId: string,
		environmentId: string | null,
		label: string,
		expiresAt: Date | null = null,
	): Promise<{ secret: string; row: OauthClientSecretDTO }> {
		const secret = generateClientSecret();
		const row: OauthClientSecret = {
			clientId,
			createdAt: new Date(),
			environmentId,
			expiresAt,
			hint: secret.slice(-4),
			id: crypto.randomUUID(),
			label,
			lastUsedAt: null,
			secretHash: hashClientSecret(secret),
		};
		await db.insert(oauthClientSecret).values(row);
		return { row: new OauthClientSecretDTO(row), secret };
	}

	/** Deletes the expired test secrets, which nothing can use any more. */
	static async purgeExpired(): Promise<void> {
		await db
			.delete(oauthClientSecret)
			.where(lt(oauthClientSecret.expiresAt, new Date()));
	}

	/** Records that the secret just authenticated a request. */
	async touch(): Promise<void> {
		const now = new Date();
		await db
			.update(oauthClientSecret)
			.set({ lastUsedAt: now })
			.where(eq(oauthClientSecret.id, this.row.id));
		this.row.lastUsedAt = now;
	}

	/** Revokes the secret: it stops working at once. */
	async delete(): Promise<void> {
		await db
			.delete(oauthClientSecret)
			.where(eq(oauthClientSecret.id, this.row.id));
	}

	/** The environment the secret belongs to, null for a test secret. */
	get environmentId(): string | null {
		return this.row.environmentId;
	}

	/** Everything but the hash, for the admin pages. */
	summary(): OauthClientSecretSummary {
		const { secretHash: _secretHash, ...rest } = this.row;
		return rest;
	}
}
