import { and, asc, eq } from "drizzle-orm";
import { DEFAULT_NOTIFICATION_EVENTS } from "#lib/notification-events.js";
import { db } from "#lib/server/db/lib.js";
import {
	type NotificationChannel,
	notificationChannel,
} from "#lib/server/db/schema.js";
import { searchCondition } from "#lib/server/list-query.js";
import type { NotificationChannelKind, NotificationEvent } from "#lib/types.js";
import { BaseDTO } from "./base-dto";

export interface NewNotificationChannelInput {
	enabled?: boolean;
	events?: NotificationEvent[];
	groupMessages?: boolean;
	kind: NotificationChannelKind;
	name: string;
	target: string;
	userId: string;
}

export type NotificationChannelUpdateInput = Partial<
	Pick<
		NotificationChannel,
		| "enabled"
		| "events"
		| "groupMessages"
		| "kind"
		| "lastError"
		| "name"
		| "target"
	>
>;

/**
 * Wraps the `notification_channel` table : an external destination (webhook,
 * Discord, Slack, Telegram or email) that selected notification events are
 * delivered to.
 */
export class NotificationChannelDTO extends BaseDTO<NotificationChannel> {
	/**
	 * Loads one channel by id, scoped to its owner; null when missing or owned by
	 * someone else.
	 */
	static async get(
		id: string,
		userId: string,
	): Promise<NotificationChannelDTO | null> {
		const [row] = await db
			.select()
			.from(notificationChannel)
			.where(
				and(
					eq(notificationChannel.id, id),
					eq(notificationChannel.userId, userId),
				),
			)
			.limit(1);
		return row ? new NotificationChannelDTO(row) : null;
	}

	/**
	 * Loads one channel by id without an owner check, for the queued delivery
	 * retry, which runs outside any request; null when it was deleted since.
	 */
	static async getForDelivery(
		id: string,
	): Promise<NotificationChannelDTO | null> {
		const [row] = await db
			.select()
			.from(notificationChannel)
			.where(eq(notificationChannel.id, id))
			.limit(1);
		return row ? new NotificationChannelDTO(row) : null;
	}

	/** Every channel the user owns, sorted by name. */
	static async list(userId: string): Promise<NotificationChannelDTO[]> {
		const rows = await db
			.select()
			.from(notificationChannel)
			.where(eq(notificationChannel.userId, userId))
			.orderBy(asc(notificationChannel.name));
		return rows.map((row) => new NotificationChannelDTO(row));
	}

	/**
	 * Every account's enabled channels subscribed to `event`, sorted by name :
	 * events are about shared resources, so each account's own channels hear
	 * about all of them.
	 */
	static async listSubscribed(
		event: NotificationEvent,
	): Promise<NotificationChannelDTO[]> {
		const rows = await db
			.select()
			.from(notificationChannel)
			.where(eq(notificationChannel.enabled, true))
			.orderBy(asc(notificationChannel.name));
		return rows
			.filter((row) => row.events.includes(event))
			.map((row) => new NotificationChannelDTO(row));
	}

	/**
	 * Up to `limit` of the user's channels whose name or kind matches `q`, for
	 * global search.
	 */
	static async search(
		userId: string,
		q: string,
		limit: number,
	): Promise<NotificationChannelDTO[]> {
		const rows = await db
			.select()
			.from(notificationChannel)
			.where(
				and(
					eq(notificationChannel.userId, userId),
					searchCondition(q, [
						notificationChannel.name,
						notificationChannel.kind,
					]),
				),
			)
			.orderBy(asc(notificationChannel.name))
			.limit(limit);
		return rows.map((row) => new NotificationChannelDTO(row));
	}

	/**
	 * Inserts a new channel, enabled and subscribed to the default events unless
	 * told otherwise.
	 */
	static async create(
		input: NewNotificationChannelInput,
	): Promise<NotificationChannelDTO> {
		const now = new Date();
		const row: NotificationChannel = {
			createdAt: now,
			enabled: input.enabled ?? true,
			events: input.events ?? [...DEFAULT_NOTIFICATION_EVENTS],
			groupMessages: input.groupMessages ?? false,
			id: crypto.randomUUID(),
			kind: input.kind,
			lastError: null,
			name: input.name,
			target: input.target,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(notificationChannel).values(row);
		return new NotificationChannelDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: NotificationChannelUpdateInput): Promise<void> {
		await db
			.update(notificationChannel)
			.set(input)
			.where(eq(notificationChannel.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Deletes this channel row. */
	async delete(): Promise<void> {
		await db
			.delete(notificationChannel)
			.where(eq(notificationChannel.id, this.row.id));
	}

	/** The channel's id. */
	get id(): string {
		return this.row.id;
	}
	/** The id of the user who owns the channel. */
	get userId(): string {
		return this.row.userId;
	}
	/** Whether the channel currently receives notifications. */
	get enabled(): boolean {
		return this.row.enabled;
	}
	/** The notification events the channel is subscribed to. */
	get events(): NotificationEvent[] {
		return this.row.events;
	}
	/** Whether notifications close together reach the channel folded into one message, see `NotificationGrouper`. */
	get groupMessages(): boolean {
		return this.row.groupMessages;
	}
	/** Which delivery integration the channel uses. */
	get kind(): NotificationChannelKind {
		return this.row.kind;
	}
	/** The channel's display name. */
	get name(): string {
		return this.row.name;
	}
	/**
	 * Where the channel delivers to (a URL or address, depending on its kind).
	 */
	get target(): string {
		return this.row.target;
	}
}
