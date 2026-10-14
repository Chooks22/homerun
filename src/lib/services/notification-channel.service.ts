import { config, isSmtpEnabled, serviceDomain } from "#lib/config.js";
import { type DeployTrigger, isRollback } from "#lib/deploy-trigger.js";
import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { JobDTO, type NewJobInput } from "#lib/dto/job-dto.js";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { parseTelegramTarget } from "#lib/notification-channel-target.js";
import {
	isFailureEvent,
	NOTIFICATION_EVENTS,
} from "#lib/notification-events.js";
import { brandedEmail } from "#lib/server/email-layout.js";
import {
	type PushPayload,
	PushSubscriptionGoneError,
	pushSubscriptionSchema,
} from "#lib/server/web-push.js";
import { primaryHostname } from "#lib/service-domains.js";
import { serviceHostname } from "./dns.service";
import { EmailService } from "./email.service";
import {
	groupedMessage,
	type MessageGroup,
	NotificationGrouper,
	scheduledNotification,
} from "./notification-grouping";
import {
	type ChannelMessage,
	deployMessage,
	deployStartedMessage,
	type MessageField,
	withStackTitle,
} from "./notification-messages";
import { QueueService } from "./queue.service";
import { WebPushService } from "./web-push.service";

const logger = new Logger("NotificationChannels");

const WEBHOOK_TIMEOUT_MS = 10_000;

const GROUP_TICK_MS = 10_000;

const DELIVERY_RETRY_ATTEMPTS = 4;
const DELIVERY_RETRY_DELAY_MS = 30_000;

const SLACK_TEXT_LIMIT = 2900;
const SLACK_INLINE_MAX = 40;
const SLACK_RED = "#ef4444";
const SLACK_GREEN = "#10b981";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_DETAIL_LIMIT = 2500;

const DISCORD_DESCRIPTION_LIMIT = 4000;
const DISCORD_FIELD_LIMIT = 1024;
const DISCORD_INLINE_MAX = 40;

const PUSH_BODY_LIMIT = 240;

const DISCORD_RED = 0xef_44_44;
const DISCORD_GREEN = 0x10_b9_81;

export interface DispatchOptions {
	/** Fired by a scheduler: held and reported with the rest of its run. */
	scheduled?: boolean;
}

export interface DeployNotification {
	dep: DeploymentDTO;
	ok: boolean;
	svc: ServiceDTO;
	trigger: DeployTrigger;
}

export interface DeployStartedNotification {
	dep: DeploymentDTO;
	svc: ServiceDTO;
	trigger: DeployTrigger;
}

function keepTail(text: string, limit: number): string {
	return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function keepHead(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** The email subject line for a channel message. */
export function messageSubject(message: ChannelMessage): string {
	return `[Homerun] ${message.title}`;
}

/** A message's fields with its service first, or just its fields for a message about the whole server. */
function withService(message: ChannelMessage): MessageField[] {
	return message.serviceName
		? [{ name: "Service", value: message.serviceName }, ...message.fields]
		: message.fields;
}

/** Renders a channel message as a branded email: its fields as a table, its link as a button, its detail as a monospace block. */
export function messageEmail(message: ChannelMessage): {
	content: string;
	html: string;
} {
	const label =
		NOTIFICATION_EVENTS.find((info) => info.event === message.event)?.label ??
		message.event;
	return brandedEmail({
		...(message.link
			? { action: { label: "Open in Homerun", url: message.link } }
			: {}),
		details: [
			...withService(message),
			{ name: "Event", value: label },
			{ name: "At", value: message.timestamp },
		],
		heading: message.title,
		paragraphs: [],
		...(message.detail ? { pre: message.detail } : {}),
		preheader: message.serviceName
			? `${label} · ${message.serviceName}`
			: label,
	});
}

/** Renders a channel message as plain-text body lines, for the generic webhook payload. */
export function messageBody(message: ChannelMessage): string {
	const label =
		NOTIFICATION_EVENTS.find((info) => info.event === message.event)?.label ??
		message.event;
	const lines = [
		message.title,
		"",
		...(message.serviceName ? [`Service: ${message.serviceName}`] : []),
		`Event: ${label}`,
		...message.fields.map(
			(field) =>
				`${field.name}:${field.value.includes("\n") ? "\n" : " "}${field.value}`,
		),
		`At: ${message.timestamp}`,
	];
	if (message.link) {
		lines.push(`Open: ${message.link}`);
	}
	if (message.detail) {
		lines.push("", message.detail);
	}
	return lines.join("\n");
}

/** Renders a channel message as a Discord webhook embed payload, truncated to Discord's own field/description limits. */
export function discordPayload(message: ChannelMessage) {
	const detail = message.detail
		? keepTail(message.detail, DISCORD_DESCRIPTION_LIMIT)
		: "";
	return {
		embeds: [
			{
				color: isFailureEvent(message.event) ? DISCORD_RED : DISCORD_GREEN,
				description: detail ? `\`\`\`\n${detail}\n\`\`\`` : undefined,
				fields: withService(message).map((field) => ({
					inline: field.inline ?? field.value.length <= DISCORD_INLINE_MAX,
					name: field.name,
					value: keepHead(field.value, DISCORD_FIELD_LIMIT),
				})),
				footer: { text: message.event },
				timestamp: message.timestamp,
				title: message.title,
				url: message.link ?? undefined,
			},
		],
		username: "Homerun",
	};
}

/** Renders a channel message as a Slack incoming-webhook payload: a coloured attachment with the fields and the detail's tail. */
export function slackPayload(message: ChannelMessage) {
	const detail = message.detail
		? `\`\`\`${keepTail(message.detail, SLACK_TEXT_LIMIT)}\`\`\``
		: undefined;
	return {
		attachments: [
			{
				color: isFailureEvent(message.event) ? SLACK_RED : SLACK_GREEN,
				fallback: message.title,
				fields: withService(message).map((field) => ({
					short: field.inline ?? field.value.length <= SLACK_INLINE_MAX,
					title: field.name,
					value: keepHead(field.value, SLACK_TEXT_LIMIT),
				})),
				footer: message.event,
				text: detail,
				title: message.title,
				title_link: message.link ?? undefined,
				ts: Math.floor(Date.parse(message.timestamp) / 1000),
			},
		],
		text: message.title,
	};
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Renders a channel message as a Telegram `sendMessage` body in HTML parse mode, kept under Telegram's 4096-character limit. */
export function telegramPayload(chatId: string, message: ChannelMessage) {
	const lines = [
		`<b>${escapeHtml(message.title)}</b>`,
		"",
		...withService(message).map(
			(field) =>
				`<b>${escapeHtml(field.name)}:</b>${field.value.includes("\n") ? "\n" : " "}${escapeHtml(field.value)}`,
		),
	];
	if (message.link) {
		lines.push(`<a href="${escapeHtml(message.link)}">Open in Homerun</a>`);
	}
	if (message.detail) {
		lines.push(
			"",
			`<pre>${escapeHtml(keepTail(message.detail, TELEGRAM_DETAIL_LIMIT))}</pre>`,
		);
	}
	const text = lines.join("\n");
	return {
		chat_id: chatId,
		disable_web_page_preview: true,
		parse_mode: "HTML",
		text:
			text.length > TELEGRAM_TEXT_LIMIT
				? escapeHtml(keepHead(messageBody(message), TELEGRAM_TEXT_LIMIT - 10))
				: text,
	};
}

/**
 * Renders a channel message as a Web Push payload for the service worker: the
 * title, the detail's first line or else the fields on one line, a tag shared
 * by a service's start and outcome of the same kind (so "is building" is
 * replaced by how the build ended) and where a click leads.
 */
export function pushPayload(message: ChannelMessage): PushPayload {
	const firstLine = message.detail?.split("\n").find((line) => line.trim());
	const body =
		firstLine ??
		withService(message)
			.filter((field) => !field.value.includes("\n"))
			.map((field) => `${field.name}: ${field.value}`)
			.join(" · ");
	const realService =
		message.serviceId && message.serviceId !== "test"
			? message.serviceId
			: null;
	return {
		body: keepHead(body, PUSH_BODY_LIMIT),
		tag: `${realService ?? "homerun"}:${message.event.split(".")[0]}`,
		title: message.title,
		url:
			message.link ??
			(realService ? `/services/${realService}` : "/notifications"),
	};
}

/**
 * The queued job that retries a failed delivery to one channel, starting
 * `DELIVERY_RETRY_DELAY_MS` from `now` and backing off exponentially through
 * the worker's own retry schedule.
 */
export function deliveryRetryJob(
	channel: { id: string; name: string; userId: string },
	message: ChannelMessage,
	now = new Date(),
): NewJobInput {
	return {
		maxAttempts: DELIVERY_RETRY_ATTEMPTS,
		payload: { channelId: channel.id, message: { ...message } },
		runAt: new Date(now.getTime() + DELIVERY_RETRY_DELAY_MS),
		title: `Deliver "${message.title}" to ${channel.name}`,
		type: "notification_delivery",
		userId: channel.userId,
	};
}

class NotificationChannelServiceClass {
	readonly #grouper = new NotificationGrouper();
	#ticker: ReturnType<typeof setInterval> | null = null;

	/**
	 * Fire-and-forget dispatch of `message` to every account's channels
	 * subscribed to that event, grouped like `dispatch`. Failures are logged,
	 * never thrown to the caller.
	 */
	notify(message: ChannelMessage, options: DispatchOptions = {}): void {
		this.dispatch(message, options).catch((err) => {
			logger.warn(
				`Channel dispatch failed: event=${message.event} : ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	/**
	 * Fire-and-forget deploy-outcome notification: builds the deploy message
	 * (looking up the service's stack for its hostname) and dispatches it.
	 * Failures are logged, never thrown to the caller.
	 */
	notifyDeploy(notification: DeployNotification): void {
		this.#deployMessage(notification)
			.then((message) =>
				this.dispatch(message, {
					scheduled: notification.trigger === "cron",
				}),
			)
			.catch((err) => {
				logger.warn(
					`Deploy notification failed: service=${notification.svc.id} : ${err instanceof Error ? err.message : String(err)}`,
				);
			});
	}

	/**
	 * Fire-and-forget "is building" / "is deploying" notification for a deploy
	 * the worker is about to run. A scheduled run sends none, its outcome is
	 * reported with the rest of the run. Failures are logged, never thrown.
	 */
	notifyDeployStarted({ dep, svc, trigger }: DeployStartedNotification): void {
		if (trigger === "cron") {
			return;
		}
		this.#deployStartedMessage(dep, svc, trigger)
			.then((message) => this.dispatch(message))
			.catch((err) => {
				logger.warn(
					`Deploy started notification failed: service=${svc.id} : ${err instanceof Error ? err.message : String(err)}`,
				);
			});
	}

	/** Builds the "is building" / "is deploying" `ChannelMessage`, looking up the service's stack name. */
	async #deployStartedMessage(
		dep: DeploymentDTO,
		svc: ServiceDTO,
		trigger: DeployTrigger,
	): Promise<ChannelMessage> {
		const stack = svc.stackId ? await StackDTO.get(svc.stackId) : null;
		return deployStartedMessage(
			{
				deployment: dep.toJSON(),
				origin: config.auth.origin ?? null,
				publicUrl: null,
				rollback: isRollback(dep.rollbackOfDeploymentId, trigger),
				service: svc.toJSON(),
				stackName: stack?.name ?? null,
				trigger,
			},
			new Date().toISOString(),
		);
	}

	/** Builds the deploy-outcome `ChannelMessage`, resolving the service's public URL from its stack (if any) and DNS-resolvable state. */
	async #deployMessage({
		dep: deployment,
		ok,
		svc: service,
		trigger,
	}: DeployNotification): Promise<ChannelMessage> {
		const stack = service.stackId ? await StackDTO.get(service.stackId) : null;
		const row = service.toJSON();
		const host =
			primaryHostname(row, stack?.slug, serviceDomain()) ??
			serviceHostname(row.slug, stack?.slug ?? null);
		return deployMessage(
			{
				deployment: deployment.toJSON(),
				origin: config.auth.origin ?? null,
				stackName: stack?.name ?? null,
				publicUrl: row.dnsResolvable ? `https://${host}` : null,
				service: row,
				trigger,
			},
			ok,
			new Date().toISOString(),
		);
	}

	/**
	 * Delivers `message` right away to every account's enabled channels
	 * subscribed to that event, except the ones that opted into grouping: for
	 * those it's held to go out with the ones around it (see
	 * `NotificationGrouper`): sent now when nothing went out in the last
	 * minute, otherwise with the next group, and always with the rest of its
	 * run when `options.scheduled`. A scheduled outcome is held either way, for
	 * the run's in-app summary. Per-channel failures don't reject; see `#send`.
	 */
	async dispatch(
		message: ChannelMessage,
		options: DispatchOptions = {},
	): Promise<void> {
		const scheduled = options.scheduled ?? false;
		const channels = await NotificationChannelDTO.listSubscribed(message.event);
		const direct = channels.filter((channel) => !channel.groupMessages);
		if (direct.length > 0) {
			const titled = await this.#withStackTitle(message);
			await Promise.all(direct.map((channel) => this.#send(channel, titled)));
		}
		if (!scheduled && direct.length === channels.length) {
			return;
		}
		const immediate = this.#grouper.add(message, scheduled, Date.now());
		if (immediate) {
			await this.#deliverGroup({ messages: [immediate], scheduled: false });
			return;
		}
		this.#startTicker();
	}

	/** Drops every message held for grouping, and stops the flush ticker. */
	discardPending(): void {
		this.#grouper.clear();
		this.#stopTicker();
	}

	/** Starts the ticker that flushes held groups once they're due, if it isn't running. */
	#startTicker(): void {
		if (this.#ticker) {
			return;
		}
		this.#ticker = setInterval(() => {
			this.flushDue().catch((err) => {
				logger.warn(
					`Grouped notification flush failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}, GROUP_TICK_MS);
		this.#ticker.unref?.();
	}

	/** Stops the flush ticker. */
	#stopTicker(): void {
		if (this.#ticker) {
			clearInterval(this.#ticker);
			this.#ticker = null;
		}
	}

	/** Sends every held group that's due, checking for running scheduled work only when a scheduled outcome is waiting, and stops the ticker once nothing is held. The ticker calls it every 10s. */
	async flushDue(): Promise<void> {
		const scheduledActive = this.#grouper.holdsScheduled
			? await JobDTO.hasActiveScheduledWork()
			: false;
		const groups = this.#grouper.due(Date.now(), scheduledActive);
		if (!this.#grouper.pending) {
			this.#stopTicker();
		}
		await Promise.all(groups.map((group) => this.#deliverGroup(group)));
	}

	/** Delivers a group to every channel that opted into grouping and subscribes to any of its events: each channel gets the messages it subscribes to, one as itself, several folded by `groupedMessage`. A scheduler run's group also leaves one in-app notification, channels or not. */
	async #deliverGroup(group: MessageGroup): Promise<void> {
		const events = [...new Set(group.messages.map((m) => m.event))];
		const subscribed = await Promise.all(
			events.map((event) => NotificationChannelDTO.listSubscribed(event)),
		);
		const byId = new Map(
			subscribed
				.flat()
				.filter((channel) => channel.groupMessages)
				.map((channel) => [channel.id, channel]),
		);
		if (byId.size === 0 && !group.scheduled) {
			return;
		}
		const titled = await Promise.all(
			group.messages.map((message) => this.#withStackTitle(message)),
		);
		if (group.scheduled) {
			NotificationDTO.notify(scheduledNotification(titled));
		}
		const deliveries = [...byId.values()].map((channel) => ({
			channel,
			mine: titled.filter((m) => channel.events.includes(m.event)),
		}));
		await Promise.all(
			deliveries
				.filter(({ mine }) => mine.length > 0)
				.map(({ channel, mine }) =>
					this.#send(
						channel,
						mine.length === 1 ? mine[0] : groupedMessage(mine, group.scheduled),
					),
				),
		);
	}

	/** `message` with its service's stack name in the title, see `withStackTitle`. */
	async #withStackTitle(message: ChannelMessage): Promise<ChannelMessage> {
		return withStackTitle(
			message,
			message.serviceId ? await this.#stackNameOf(message.serviceId) : null,
		);
	}

	/** The name of the stack `serviceId` belongs to, null for an ungrouped or unknown service, or when the lookup fails. */
	async #stackNameOf(serviceId: string): Promise<string | null> {
		try {
			const svc = await ServiceDTO.get(serviceId);
			const stack = svc?.stackId ? await StackDTO.get(svc.stackId) : null;
			return stack?.name ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Sends a synthetic "build failed" message directly to one channel (the
	 * Settings page's "Send test notification" button), bypassing event
	 * subscription filtering, and clears the channel's stored `lastError` on
	 * success.
	 *
	 * @throws Whatever `#deliver` throws for that channel kind.
	 */
	async sendTest(channel: NotificationChannelDTO): Promise<void> {
		await this.#deliver(channel, {
			detail: "This is a test notification from Homerun.",
			event: "build.failed",
			fields: [
				{ name: "Trigger", value: "Manual" },
				{ name: "Repository", value: "https://github.com/example/app.git" },
				{ name: "Branch", value: "main" },
				{ name: "Commit", value: "0000000" },
				{ name: "Duration", value: "42s" },
			],
			link: null,
			serviceId: "test",
			serviceName: "Test service",
			timestamp: new Date().toISOString(),
			title: "Test service failed to build",
		});
		await channel.update({ lastError: null });
	}

	/**
	 * Retries one queued delivery (the `notification_delivery` job handler).
	 * A channel deleted, disabled or unsubscribed from the event since is
	 * skipped rather than failed.
	 *
	 * @throws Whatever `#deliver` throws, after recording it as the channel's
	 * `lastError`, so the worker schedules the next attempt.
	 */
	async retryDelivery(
		channelId: string,
		message: ChannelMessage,
	): Promise<{ delivered: boolean }> {
		const channel = await NotificationChannelDTO.getForDelivery(channelId);
		if (!(channel?.enabled && channel.events.includes(message.event))) {
			return { delivered: false };
		}
		try {
			await this.#deliver(channel, message);
		} catch (err) {
			await channel.update({
				lastError: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
		await channel.update({ lastError: null });
		return { delivered: true };
	}

	/**
	 * Delivers to one channel, recording the outcome on the channel row
	 * itself (`lastError` cleared on success, set to the failure message
	 * otherwise) rather than throwing, so one bad channel doesn't affect the
	 * others in `dispatch`'s `Promise.all`. A failed delivery is queued for
	 * retry with backoff (`deliveryRetryJob`).
	 */
	async #send(
		channel: NotificationChannelDTO,
		message: ChannelMessage,
	): Promise<void> {
		try {
			await this.#deliver(channel, message);
			await channel.update({ lastError: null });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof PushSubscriptionGoneError) {
				logger.warn(`Channel "${channel.name}" disabled: ${reason}`);
				await channel.update({ lastError: reason });
				return;
			}
			logger.warn(
				`Channel "${channel.name}" failed, retrying later: ${reason}`,
			);
			await channel.update({ lastError: reason });
			await QueueService.enqueue(deliveryRetryJob(channel, message)).catch(
				(queueErr) => {
					logger.error(
						`Couldn't queue a retry for channel "${channel.name}"`,
						queueErr,
					);
				},
			);
		}
	}

	/** Routes delivery to the channel-kind-specific sender: Discord's embed payload, Slack's attachment, Telegram's bot API, email, a browser's Web Push subscription, or the generic JSON webhook POST. */
	#deliver(
		channel: NotificationChannelDTO,
		message: ChannelMessage,
	): Promise<void> {
		switch (channel.kind) {
			case "discord":
				return this.#post(channel.target, discordPayload(message));
			case "slack":
				return this.#post(channel.target, slackPayload(message));
			case "telegram":
				return this.#sendTelegram(channel.target, message);
			case "email":
				return this.#sendEmail(channel.target, message);
			case "browser":
				return this.#sendPush(channel, message);
			default:
				return this.#post(channel.target, message);
		}
	}

	/**
	 * Sends a channel message through the Telegram Bot API's `sendMessage`.
	 *
	 * @throws When the stored target isn't a bot token and chat id, the request
	 *   times out, or Telegram rejects it (with Telegram's own description,
	 *   never the bot token).
	 */
	async #sendTelegram(target: string, message: ChannelMessage): Promise<void> {
		const parsed = parseTelegramTarget(target);
		if (!parsed) {
			throw new Error("The Telegram channel has no bot token and chat id.");
		}
		let response: Response;
		try {
			response = await fetch(
				`${TELEGRAM_API}/bot${parsed.botToken}/sendMessage`,
				{
					body: JSON.stringify(telegramPayload(parsed.chatId, message)),
					headers: { "content-type": "application/json" },
					method: "POST",
					signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
				},
			);
		} catch (err) {
			const reason =
				err instanceof Error && err.name === "TimeoutError"
					? "timed out"
					: "couldn't be reached";
			throw new Error(`Telegram ${reason}`);
		}
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				description?: string;
			} | null;
			throw new Error(
				`Telegram returned HTTP ${response.status}${body?.description ? `: ${body.description}` : ""}`,
			);
		}
	}

	/**
	 * Sends a channel message to a browser through its Web Push subscription,
	 * which the service worker shows even with no Homerun tab open. A
	 * subscription the push service says is gone disables the channel.
	 *
	 * @throws `PushSubscriptionGoneError` for an expired subscription, an
	 *   `Error` when the stored target isn't a subscription or the push service
	 *   refuses.
	 */
	async #sendPush(
		channel: NotificationChannelDTO,
		message: ChannelMessage,
	): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(channel.target);
		} catch {
			parsed = null;
		}
		const subscription = pushSubscriptionSchema.safeParse(parsed);
		if (!subscription.success) {
			throw new Error("The browser channel has no push subscription.");
		}
		try {
			await WebPushService.send(subscription.data, pushPayload(message));
		} catch (err) {
			if (err instanceof PushSubscriptionGoneError) {
				await channel.update({ enabled: false });
			}
			throw err;
		}
	}

	/**
	 * POSTs `body` as JSON to a generic webhook URL.
	 *
	 * @throws When the request times out (`WEBHOOK_TIMEOUT_MS`) or the
	 *   response isn't ok.
	 */
	async #post(url: string, body: unknown): Promise<void> {
		const response = await fetch(url, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`Webhook returned HTTP ${response.status}`);
		}
	}

	/**
	 * Sends a channel message by email.
	 *
	 * @throws When SMTP isn't configured on this instance.
	 */
	async #sendEmail(to: string, message: ChannelMessage): Promise<void> {
		if (!isSmtpEnabled()) {
			throw new Error(
				"SMTP isn't configured, so email notifications can't be sent.",
			);
		}
		await new EmailService({
			...messageEmail(message),
			subject: messageSubject(message),
			to,
		}).send();
	}
}

export const NotificationChannelService = new NotificationChannelServiceClass();
