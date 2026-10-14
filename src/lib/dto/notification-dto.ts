import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import {
	type Notification,
	notification,
	service,
	stack,
	user,
} from "#lib/server/db/schema.js";
import { SERVICE_ACCOUNT } from "#lib/user-types.js";
import { BaseDTO } from "./base-dto";

export interface NewNotificationInput {
	detail?: string | null;
	message: string;
	serviceId?: string | null;
	type: Notification["type"];
}

// Same amortized-prune convention as AppLogDTO, per user rather than
// instance-wide (each user's own bell feed stays bounded independently).
export const MAX_ROWS_PER_USER = 200;
const PRUNE_PROBABILITY = 0.05;

/** Wraps the `notification` table : the bell-icon feed, see schema.ts's docstring on `notification`. */
export class NotificationDTO extends BaseDTO<Notification> {
	/** Most recent notifications for one user (only the unread ones when `unreadOnly`), newest first, with the related service's slug and stack name joined in for the feed to link out to it. */
	static async listForUser(
		userId: string,
		limit = 30,
		unreadOnly = false,
	): Promise<
		Array<{
			notification: NotificationDTO;
			serviceSlug: string | null;
			stackName: string | null;
		}>
	> {
		const rows = await db
			.select({
				row: notification,
				serviceSlug: service.slug,
				stackName: stack.name,
			})
			.from(notification)
			.leftJoin(service, eq(notification.serviceId, service.id))
			.leftJoin(stack, eq(service.stackId, stack.id))
			.where(
				and(
					eq(notification.userId, userId),
					unreadOnly ? isNull(notification.readAt) : undefined,
				),
			)
			.orderBy(desc(notification.createdAt))
			.limit(limit);
		return rows.map((r) => ({
			notification: new NotificationDTO(r.row),
			serviceSlug: r.serviceSlug,
			stackName: r.stackName,
		}));
	}

	/**
	 * How many of the user's notifications are still unread, for the bell badge.
	 */
	static async unreadCount(userId: string): Promise<number> {
		const rows = await db
			.select({ id: notification.id })
			.from(notification)
			.where(and(eq(notification.userId, userId), isNull(notification.readAt)));
		return rows.length;
	}

	/**
	 * Fire-and-forget fan-out to every account's bell feed, same posture as
	 * Logger.warn/error's app_log write : never awaited by the caller, never
	 * throws, since a failed notification write shouldn't fail the operation
	 * it's notifying about.
	 */
	static notify(input: NewNotificationInput): void {
		NotificationDTO.broadcast(input).catch(() => undefined);
	}

	/**
	 * Inserts one copy of a notification per account, since every account
	 * shares every resource, and on roughly 5% of writes prunes each feed back
	 * down to its newest 200 entries.
	 */
	static async broadcast(input: NewNotificationInput): Promise<void> {
		const users = await db
			.select({ id: user.id })
			.from(user)
			.where(ne(user.type, SERVICE_ACCOUNT));
		if (users.length === 0) {
			return;
		}
		const createdAt = new Date();
		await db.insert(notification).values(
			users.map(
				(account): Notification => ({
					createdAt,
					detail: input.detail ?? null,
					id: crypto.randomUUID(),
					message: input.message,
					readAt: null,
					serviceId: input.serviceId ?? null,
					type: input.type,
					userId: account.id,
				}),
			),
		);

		if (Math.random() < PRUNE_PROBABILITY) {
			await Promise.all(
				users.map((account) => NotificationDTO.prune(account.id)),
			);
		}
	}

	/** Deletes everything past the user's newest 200 notifications. */
	static async prune(userId: string): Promise<void> {
		const [cutoff] = await db
			.select({ createdAt: notification.createdAt })
			.from(notification)
			.where(eq(notification.userId, userId))
			.orderBy(desc(notification.createdAt))
			.limit(1)
			.offset(MAX_ROWS_PER_USER - 1);
		if (!cutoff) {
			return;
		}
		await db
			.delete(notification)
			.where(
				and(
					eq(notification.userId, userId),
					lt(notification.createdAt, cutoff.createdAt),
				),
			);
	}

	/** Marks every unread notification of the user as read now. */
	static async markAllRead(userId: string): Promise<void> {
		await db
			.update(notification)
			.set({ readAt: new Date() })
			.where(and(eq(notification.userId, userId), isNull(notification.readAt)));
	}

	/** Marks one notification as read now, scoped to its owner. */
	static async markRead(id: string, userId: string): Promise<void> {
		await db
			.update(notification)
			.set({ readAt: new Date() })
			.where(and(eq(notification.id, id), eq(notification.userId, userId)));
	}

	/** Removes one notification, scoped to its owner so a user can't delete another user's row. */
	static async delete(id: string, userId: string): Promise<void> {
		await db
			.delete(notification)
			.where(and(eq(notification.id, id), eq(notification.userId, userId)));
	}

	/** Clears a user's whole feed, read or not. */
	static async deleteAll(userId: string): Promise<void> {
		await db.delete(notification).where(eq(notification.userId, userId));
	}

	/**
	 * Notifies every account of an app-level error attributed to a service
	 * (Logger.error()'s "app runtime failures" feed item), looked up by
	 * `serviceId` alone since the logging call site only knows the service
	 * (see logger.ts's persistLog, same heuristic-attribution shape as
	 * AppLogDTO).
	 */
	static async notifyServiceError(
		serviceId: string,
		message: string,
	): Promise<void> {
		const [row] = await db
			.select({ name: service.name })
			.from(service)
			.where(eq(service.id, serviceId))
			.limit(1);
		if (!row) {
			return;
		}
		await NotificationDTO.broadcast({
			message: `"${row.name}" hit a runtime error: ${message}`,
			serviceId,
			type: "app_runtime_error",
		});
	}
}
