import { and, asc, eq } from "drizzle-orm";
import { AuditLogDTO, type NewAuditLogInput } from "#lib/dto/audit-log-dto.js";
import { Logger } from "#lib/logger.js";
import { type Permissions, parsePermissions } from "#lib/permissions.js";
import { db } from "#lib/server/db/lib.js";
import {
	apikey as apikeyTable,
	type User,
	user as userTable,
} from "#lib/server/db/schema.js";
import { forgetGateAccess } from "#lib/server/gate-access-cache.js";
import {
	SERVICE_ACCOUNT,
	SERVICE_ACCOUNT_EMAIL_DOMAIN,
} from "#lib/user-types.js";
import { isBanned } from "./app-access.service.ts";
import { auth } from "./auth.ts";
import { UserService } from "./user.service.ts";

const logger = new Logger("ServiceAccounts");

const DISABLED_REASON = "Service account disabled";

export interface ServiceAccountView {
	createdAt: Date;
	disabled: boolean;
	id: string;
	name: string;
	permissions: Permissions;
	updatedAt: Date;
}

export interface ServiceAccountKeyView {
	createdAt: Date;
	expiresAt: Date | null;
	id: string;
	lastRequest: Date | null;
	name: string | null;
	prefix: string | null;
	start: string | null;
}

export interface CreatedServiceAccountKey {
	expiresAt: Date | null;
	id: string;
	key: string;
	name: string | null;
}

export interface ServiceAccountChanges {
	disabled?: boolean;
	name?: string;
	permissions?: Permissions;
}

/** Turns a service account's user row into the shape the dashboard and the API return. */
function toView(row: User): ServiceAccountView {
	return {
		createdAt: row.createdAt,
		disabled: isBanned(row),
		id: row.id,
		name: row.name,
		permissions: parsePermissions(row.permissions),
		updatedAt: row.updatedAt,
	};
}

/**
 * Service accounts: `user` rows typed `service-account`, with no sign-in
 * method (auth.ts refuses them a session) and API keys as their only
 * credential. They hold the custom role, with no permissions unless an admin
 * picks some, and get through a login wall only when listed by id.
 */
class ServiceAccountServiceClass {
	/** Every service account, oldest first. */
	async list(): Promise<ServiceAccountView[]> {
		const rows = await db
			.select()
			.from(userTable)
			.where(eq(userTable.type, SERVICE_ACCOUNT))
			.orderBy(asc(userTable.createdAt));
		return rows.map(toView);
	}

	/** One service account, or null when `id` isn't one. */
	async get(id: string): Promise<ServiceAccountView | null> {
		const row = await this.#row(id);
		return row ? toView(row) : null;
	}

	/** Creates a service account, enabled, with the permissions given (none by default). */
	async create(
		name: string,
		permissions: Permissions,
		createdBy: string,
	): Promise<ServiceAccountView> {
		const id = crypto.randomUUID();
		const now = new Date();
		const [row] = await db
			.insert(userTable)
			.values({
				createdAt: now,
				email: `${id}@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`,
				emailVerified: false,
				id,
				name,
				permissions,
				role: "custom",
				type: SERVICE_ACCOUNT,
				updatedAt: now,
			})
			.returning();
		logger.info(`Service account created: account=${id} by=${createdBy}`);
		return toView(row);
	}

	/**
	 * Renames, re-permissions, disables or re-enables a service account.
	 * Disabling bans the row, which refuses its keys from the next request
	 * and drops its cached login-wall decisions so gate cookies already
	 * issued to it stop working too.
	 *
	 * @returns The updated account, or null when `id` isn't one.
	 */
	async update(
		id: string,
		changes: ServiceAccountChanges,
		updatedBy: string,
	): Promise<ServiceAccountView | null> {
		if (!(await this.#row(id))) {
			return null;
		}
		const [row] = await db
			.update(userTable)
			.set({
				...(changes.name === undefined ? {} : { name: changes.name }),
				...(changes.permissions === undefined
					? {}
					: { permissions: changes.permissions }),
				...(changes.disabled === undefined
					? {}
					: {
							banExpires: null,
							banned: changes.disabled,
							banReason: changes.disabled ? DISABLED_REASON : null,
						}),
			})
			.where(eq(userTable.id, id))
			.returning();
		forgetGateAccess(id);
		logger.info(
			`Service account updated: account=${id} fields=${Object.keys(changes).join(",")} by=${updatedBy}`,
		);
		return toView(row);
	}

	/**
	 * Deletes a service account and its API keys, handing anything it created
	 * over to `deletedBy` first. Its audit log entries stay.
	 *
	 * @returns False when `id` isn't a service account.
	 */
	async delete(id: string, deletedBy: string): Promise<boolean> {
		if (!(await this.#row(id))) {
			return false;
		}
		await UserService.cleanupUserResources(id, deletedBy);
		await db.delete(apikeyTable).where(eq(apikeyTable.referenceId, id));
		await UserService.deleteUser(id);
		forgetGateAccess(id);
		logger.info(`Service account deleted: account=${id} by=${deletedBy}`);
		return true;
	}

	/** The account's API keys, newest first, without their secrets. */
	async listKeys(id: string): Promise<ServiceAccountKeyView[]> {
		const rows = await db
			.select({
				createdAt: apikeyTable.createdAt,
				expiresAt: apikeyTable.expiresAt,
				id: apikeyTable.id,
				lastRequest: apikeyTable.lastRequest,
				name: apikeyTable.name,
				prefix: apikeyTable.prefix,
				start: apikeyTable.start,
			})
			.from(apikeyTable)
			.where(eq(apikeyTable.referenceId, id));
		return rows.toSorted(
			(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
		);
	}

	/**
	 * Mints an API key for the account. The key carries no permissions of its
	 * own, so it does exactly what the account may do, including changes made
	 * to the account later. The secret is only in the return value.
	 *
	 * @returns The key, or null when `id` isn't a service account.
	 */
	async createKey(
		id: string,
		name: string,
		expiresInDays: number | null,
		createdBy: string,
	): Promise<CreatedServiceAccountKey | null> {
		if (!(await this.#row(id))) {
			return null;
		}
		const created = await auth.api.createApiKey({
			body: {
				expiresIn: expiresInDays ? expiresInDays * 86_400 : null,
				name,
				userId: id,
			},
		});
		logger.info(
			`Service account key created: account=${id} key=${created.id} by=${createdBy}`,
		);
		return {
			expiresAt: created.expiresAt ? new Date(created.expiresAt) : null,
			id: created.id,
			key: created.key,
			name: created.name ?? null,
		};
	}

	/**
	 * Revokes one of the account's API keys.
	 *
	 * @returns False when the key doesn't exist or belongs to someone else.
	 */
	async revokeKey(
		id: string,
		keyId: string,
		revokedBy: string,
	): Promise<boolean> {
		const deleted = await db
			.delete(apikeyTable)
			.where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, id)))
			.returning({ id: apikeyTable.id });
		if (deleted.length === 0) {
			return false;
		}
		logger.info(
			`Service account key revoked: account=${id} key=${keyId} by=${revokedBy}`,
		);
		return true;
	}

	/** Writes one use of a service account's key to the audit log; never throws. */
	async recordUse(
		account: { id: string; name: string },
		use: Pick<NewAuditLogInput, "action" | "detail" | "ipAddress" | "status">,
	): Promise<void> {
		try {
			await AuditLogDTO.create({
				...use,
				actorId: account.id,
				actorName: account.name,
			});
		} catch (error) {
			logger.warn(
				`Couldn't write a service account audit entry: account=${account.id}`,
				error,
			);
		}
	}

	/** The service account's user row, or null when `id` isn't one. */
	async #row(id: string): Promise<User | null> {
		const [row] = await db
			.select()
			.from(userTable)
			.where(and(eq(userTable.id, id), eq(userTable.type, SERVICE_ACCOUNT)))
			.limit(1);
		return row ?? null;
	}
}

export const ServiceAccountService = new ServiceAccountServiceClass();
