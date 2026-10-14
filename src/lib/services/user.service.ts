import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import { Logger } from "#lib/logger.js";
import {
	type Permissions,
	permissionsForRole,
	type Role,
} from "#lib/permissions.js";
import { db } from "#lib/server/db/lib.js";
import type { User } from "#lib/server/db/schema.js";
import * as schema from "#lib/server/db/schema.js";
import { user as userTable } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { SERVICE_ACCOUNT } from "#lib/user-types.js";
import { DockerService } from "./docker.service.ts";
import { WorkstationService } from "./workstation.service.ts";

const logger = new Logger("UserCleanup");

const LAST_ADMIN_DEMOTION = "Can't demote the last admin.";
const PERMISSIONS_NEED_CUSTOM =
	"Only a custom-role user has their own permissions.";
const EMAIL_TAKEN = "That email already has an account.";

export interface AccountChanges {
	email?: string;
	name?: string;
	permissions?: Permissions;
	role?: Role;
}

/** Read/cleanup operations for the `user` table and everything a user created. */
class UserServiceClass {
	/**
	 * Hands every shared resource a user created (services, stacks, deployments,
	 * jobs, volumes, S3 destinations, build cache registries, remote hosts, cron
	 * jobs, status pages, custom templates, pending invites and registered OIDC
	 * apps) over to another account *before* the user row goes away, since
	 * every one of those foreign keys is `onDelete: cascade` and would
	 * otherwise delete the rows and orphan their running containers. Personal
	 * rows (sessions, API keys, preferences, git connections, the bell feed,
	 * notification channels) still cascade away with the user. A transferred
	 * git service builds with its new owner's git connection from then on.
	 *
	 * The successor is `actingUserId` when given (the admin removing someone),
	 * otherwise the oldest other admin, otherwise the oldest other account.
	 * When the user is the last account there's nobody to hand over to, so
	 * their containers and stack networks are removed and the rows cascade.
	 * Their workstations are personal, never handed over: they're removed,
	 * home volumes included, either way.
	 *
	 * Shared by two callers that must both get this treatment:
	 * - auth.ts's `user.deleteUser.beforeDelete` hook (self-service account
	 *   deletion).
	 * - The Users page's "remove user" action, which deletes the row with
	 *   `deleteUser` and so never runs the `deleteUser.beforeDelete` option,
	 *   so that action has to call this itself first.
	 */
	async cleanupUserResources(
		userId: string,
		actingUserId?: string,
	): Promise<void> {
		await WorkstationService.removeAllFor(userId);
		const successorId =
			actingUserId && actingUserId !== userId
				? actingUserId
				: await this.#successorFor(userId);
		if (!successorId) {
			await this.#removeHostResources(userId);
			return;
		}

		logger.info(
			`Handing over user resources: user=${userId} successor=${successorId}`,
		);
		const reassign = { userId: successorId };
		await Promise.all([
			db
				.update(schema.service)
				.set(reassign)
				.where(eq(schema.service.userId, userId)),
			db
				.update(schema.stack)
				.set(reassign)
				.where(eq(schema.stack.userId, userId)),
			db
				.update(schema.deployment)
				.set(reassign)
				.where(eq(schema.deployment.userId, userId)),
			db.update(schema.job).set(reassign).where(eq(schema.job.userId, userId)),
			db
				.update(schema.storageVolume)
				.set(reassign)
				.where(eq(schema.storageVolume.userId, userId)),
			db
				.update(schema.s3Destination)
				.set(reassign)
				.where(eq(schema.s3Destination.userId, userId)),
			db
				.update(schema.buildCacheRegistry)
				.set(reassign)
				.where(eq(schema.buildCacheRegistry.userId, userId)),
			db
				.update(schema.redirect)
				.set(reassign)
				.where(eq(schema.redirect.userId, userId)),
			db
				.update(schema.remoteHost)
				.set(reassign)
				.where(eq(schema.remoteHost.userId, userId)),
			db
				.update(schema.cronJob)
				.set(reassign)
				.where(eq(schema.cronJob.userId, userId)),
			db
				.update(schema.statusPage)
				.set(reassign)
				.where(eq(schema.statusPage.userId, userId)),
			db
				.update(schema.oauthClient)
				.set(reassign)
				.where(eq(schema.oauthClient.userId, userId)),
			db
				.update(schema.template)
				.set({ ownerId: successorId })
				.where(eq(schema.template.ownerId, userId)),
			db
				.update(schema.invitation)
				.set({ invitedByUserId: successorId })
				.where(eq(schema.invitation.invitedByUserId, userId)),
		]);
		logger.info(`User resource hand-over complete: user=${userId}`);
	}

	/**
	 * The account that inherits a deleted user's resources: the oldest other
	 * admin, else the oldest other account, else null.
	 */
	async #successorFor(userId: string): Promise<string | null> {
		const [row] = await db
			.select({ id: userTable.id })
			.from(userTable)
			.where(and(ne(userTable.id, userId), ne(userTable.type, SERVICE_ACCOUNT)))
			.orderBy(
				sql`case when ${userTable.role} = 'admin' then 0 else 1 end`,
				asc(userTable.createdAt),
			)
			.limit(1);
		return row ? row.id : null;
	}

	/**
	 * Removes the last account's containers and stack networks, which a
	 * database cascade can't reach; the rows themselves cascade with the user.
	 */
	async #removeHostResources(userId: string): Promise<void> {
		const [services, stacks] = await Promise.all([
			db.select().from(schema.service).where(eq(schema.service.userId, userId)),
			db
				.select({ id: schema.stack.id })
				.from(schema.stack)
				.where(eq(schema.stack.userId, userId)),
		]);
		logger.info(
			`Removing the last account's resources: user=${userId} services=${services.length}`,
		);
		await Promise.all(
			services.map((svc) => {
				if (svc.swarmServiceId) {
					return DockerService.removeSwarmService(svc.swarmServiceId).catch(
						() => undefined,
					);
				}
				if (svc.containerId) {
					return DockerService.removeContainer(svc.containerId, {
						force: true,
					}).catch(() => undefined);
				}
				return Promise.resolve();
			}),
		);
		await Promise.all(
			stacks.map((stack) =>
				DockerService.removeStackNetwork(stack.id).catch(() => undefined),
			),
		);
	}

	/**
	 * Small read helpers for the `user` table, used by the admin Users page.
	 * Raw queries rather than a DTO : there's no DTO for better-auth-owned
	 * tables, same precedent hooks.server.ts and auth.ts already use.
	 */
	async listUsers(): Promise<User[]> {
		return await db.select().from(userTable).orderBy(desc(userTable.createdAt));
	}

	/** One page of `listUsers`, searched/filtered server-side, plus the unpaged total. */
	async listUsersPaged(query: ListQuery): Promise<PagedResult<User>> {
		const conditions: SQL[] = [ne(userTable.type, SERVICE_ACCOUNT)];
		const search = searchCondition(query.q, [userTable.name, userTable.email]);
		if (search) {
			conditions.push(search);
		}
		const roles = query.filters.role;
		if (roles && roles.length > 0) {
			conditions.push(inArray(userTable.role, roles));
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(userTable)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: userTable.createdAt,
							name: userTable.name,
							updated: userTable.updatedAt,
						},
						desc(userTable.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(userTable).where(where),
		]);

		return {
			items: rows,
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/** Users matching `q` against name/email, newest first, capped at `limit`. Used by lookups that need a short candidate list rather than a full paged listing (e.g. an owner picker). */
	async searchUsers(q: string, limit: number): Promise<User[]> {
		return await db
			.select()
			.from(userTable)
			.where(
				and(
					ne(userTable.type, SERVICE_ACCOUNT),
					searchCondition(q, [userTable.name, userTable.email]),
				),
			)
			.orderBy(desc(userTable.createdAt))
			.limit(limit);
	}

	/** Whether `userId` is a service account, which may never hold a session. */
	async isServiceAccount(userId: string): Promise<boolean> {
		const [row] = await db
			.select({ type: userTable.type })
			.from(userTable)
			.where(eq(userTable.id, userId))
			.limit(1);
		return row?.type === SERVICE_ACCOUNT;
	}

	/** Stamps `userId`'s last sign-in time, called from better-auth's session-create hook. */
	async recordSignIn(userId: string, at: Date): Promise<void> {
		await db
			.update(userTable)
			.set({ lastSignInAt: at })
			.where(eq(userTable.id, userId));
	}

	/** The oldest admin user's id, or null if there is none. Used to attribute system-initiated actions (e.g. the scheduled mirror cleanup) to a real user. */
	async firstAdminId(): Promise<string | null> {
		const [row] = await db
			.select({ id: userTable.id })
			.from(userTable)
			.where(eq(userTable.role, "admin"))
			.orderBy(asc(userTable.createdAt))
			.limit(1);
		return row ? row.id : null;
	}

	/**
	 * Gives `userId` a role, and the permissions it holds when that role is
	 * custom. Written straight to the table rather than through better-auth's
	 * admin plugin, whose endpoints only let the `admin` role through, so a
	 * custom-role user with write access to Users can manage accounts too.
	 */
	async setRole(
		userId: string,
		role: Role,
		permissions: Permissions | null,
	): Promise<void> {
		await db
			.update(userTable)
			.set({ permissions, role })
			.where(eq(userTable.id, userId));
	}

	/** Replaces a custom-role user's permissions. */
	async setPermissions(
		userId: string,
		permissions: Permissions,
	): Promise<void> {
		await db
			.update(userTable)
			.set({ permissions })
			.where(eq(userTable.id, userId));
	}

	/** Changes `userId`'s email and marks it verified, since an admin vouched for it. */
	async setEmail(userId: string, email: string): Promise<void> {
		await db
			.update(userTable)
			.set({ email, emailVerified: true })
			.where(eq(userTable.id, userId));
	}

	/**
	 * Deletes the user row; sessions, accounts, API keys and every other
	 * personal row cascade with it. Call `cleanupUserResources` first to hand
	 * shared resources over.
	 */
	async deleteUser(userId: string): Promise<void> {
		await db.delete(userTable).where(eq(userTable.id, userId));
	}

	/** How many users currently hold the `admin` role. */
	async countAdmins(): Promise<number> {
		const [row] = await db
			.select({ total: count() })
			.from(userTable)
			.where(eq(userTable.role, "admin"));
		return row?.total ?? 0;
	}

	/** The user with this id, service accounts included, or null. */
	async getUser(userId: string): Promise<User | null> {
		const [row] = await db
			.select()
			.from(userTable)
			.where(eq(userTable.id, userId))
			.limit(1);
		return row ?? null;
	}

	/** The account holding `email` (stored lowercase), or null. */
	async findByEmail(email: string): Promise<User | null> {
		const [row] = await db
			.select()
			.from(userTable)
			.where(eq(userTable.email, email))
			.limit(1);
		return row ?? null;
	}

	/**
	 * Whether taking the admin role away from `userId` would leave the
	 * instance without any admin, which better-auth's own "can't remove
	 * yourself" guard doesn't cover.
	 */
	async wouldRemoveLastAdmin(userId: string): Promise<boolean> {
		const target = await this.getUser(userId);
		if (target?.role !== "admin") {
			return false;
		}
		return (await this.countAdmins()) <= 1;
	}

	/** Changes `userId`'s display name. */
	async setName(userId: string, name: string): Promise<void> {
		await db.update(userTable).set({ name }).where(eq(userTable.id, userId));
	}

	/**
	 * Gives `target` another role, refusing to demote the last admin.
	 * Switching to custom starts from the permissions the previous role gave.
	 *
	 * @returns Why it was refused, or null once saved.
	 */
	async changeRole(target: User, role: Role): Promise<string | null> {
		if (role !== "admin" && (await this.wouldRemoveLastAdmin(target.id))) {
			return LAST_ADMIN_DEMOTION;
		}
		await this.setRole(
			target.id,
			role,
			role === "custom"
				? permissionsForRole(target.role, target.permissions)
				: null,
		);
		return null;
	}

	/**
	 * Replaces `target`'s own permissions, which only a custom-role user has.
	 *
	 * @returns Why it was refused, or null once saved.
	 */
	async changePermissions(
		target: User,
		permissions: Permissions,
	): Promise<string | null> {
		if (target.role !== "custom") {
			return PERMISSIONS_NEED_CUSTOM;
		}
		await this.setPermissions(target.id, permissions);
		return null;
	}

	/**
	 * Changes `target`'s email, marked verified, unless another account
	 * already holds it.
	 *
	 * @returns Why it was refused, or null once saved.
	 */
	async changeEmail(target: User, email: string): Promise<string | null> {
		if (target.email === email) {
			return null;
		}
		if (await this.findByEmail(email)) {
			return EMAIL_TAKEN;
		}
		await this.setEmail(target.id, email);
		return null;
	}

	/**
	 * Changes the role, permissions, email and name given, after checking
	 * every one of them so nothing is saved when one is refused. Permissions
	 * only go with the custom role; switching to custom without them starts
	 * from the previous role's.
	 *
	 * @returns Why it was refused, or null once saved.
	 */
	async updateAccount(
		target: User,
		changes: AccountChanges,
	): Promise<string | null> {
		const role = changes.role ?? target.role;
		if (changes.permissions && role !== "custom") {
			return PERMISSIONS_NEED_CUSTOM;
		}
		if (
			changes.role &&
			changes.role !== "admin" &&
			(await this.wouldRemoveLastAdmin(target.id))
		) {
			return LAST_ADMIN_DEMOTION;
		}
		if (
			changes.email &&
			changes.email !== target.email &&
			(await this.findByEmail(changes.email))
		) {
			return EMAIL_TAKEN;
		}
		if (changes.role) {
			await this.setRole(
				target.id,
				changes.role,
				changes.role === "custom"
					? (changes.permissions ??
							permissionsForRole(target.role, target.permissions))
					: null,
			);
		} else if (changes.permissions) {
			await this.setPermissions(target.id, changes.permissions);
		}
		if (changes.email && changes.email !== target.email) {
			await this.setEmail(target.id, changes.email);
		}
		if (changes.name !== undefined && changes.name !== target.name) {
			await this.setName(target.id, changes.name);
		}
		return null;
	}

	/**
	 * Removes `userId` the way an admin does: hands their shared resources
	 * over to `actingUserId`, then deletes the row. Refuses removing yourself
	 * (Profile does that) or the last admin.
	 *
	 * @returns Why it was refused, or null once removed.
	 */
	async removeUser(
		userId: string,
		actingUserId: string,
	): Promise<string | null> {
		if (userId === actingUserId) {
			return "You can't remove your own account here : use Profile instead.";
		}
		if (await this.wouldRemoveLastAdmin(userId)) {
			return "Can't remove the last admin.";
		}
		await this.cleanupUserResources(userId, actingUserId);
		await this.deleteUser(userId);
		return null;
	}
}

export const UserService = new UserServiceClass();
