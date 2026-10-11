import { z } from "zod";
import {
	formatTelegramTarget,
	parseTelegramTarget,
} from "#lib/notification-channel-target.js";
import { pushSubscriptionSchema } from "#lib/server/web-push.js";
import type { NotificationChannelKind } from "#lib/types.js";

const DISCORD_HOSTS = new Set([
	"discord.com",
	"discordapp.com",
	"canary.discord.com",
	"ptb.discord.com",
]);

const SLACK_HOST = "hooks.slack.com";
const SLACK_PATHS = ["/services/", "/triggers/", "/workflows/"];
const TELEGRAM_BOT_TOKEN = /^\d+:[\w-]{30,}$/;
const TELEGRAM_CHAT_ID = /^(-?\d+|@\w{5,})$/;

export const notificationChannelSchema = z.object({
	kind: z.enum(["webhook", "discord", "slack", "telegram", "email", "browser"]),
	name: z.string().trim().min(1, "Give the channel a name.").max(100),
	target: z.string().trim().min(1, "Give the channel a destination."),
});

/**
 * Builds the stored `target` from the create or edit form : the `target` field
 * as is, except for Telegram, whose bot token and chat id fields are packed
 * into one. Given the channel being edited, its kind wins over the form's and a
 * blank bot token keeps the stored one, since the browser never sees it. A
 * browser channel's subscription is never edited through a form, so it keeps
 * its stored one.
 */
export function channelTargetFromForm(
	form: FormData,
	current?: { kind: NotificationChannelKind; target: string },
): string {
	if (current?.kind === "browser") {
		return current.target;
	}
	if ((current?.kind ?? form.get("kind")) !== "telegram") {
		return String(form.get("target") ?? "");
	}
	const botToken =
		String(form.get("telegramBotToken") ?? "").trim() ||
		(current ? (parseTelegramTarget(current.target)?.botToken ?? "") : "");
	const chatId = String(form.get("telegramChatId") ?? "").trim();
	return botToken || chatId ? formatTelegramTarget({ botToken, chatId }) : "";
}

/**
 * Checks a Telegram target is a bot token (`123456:ABC…`) and a numeric chat
 * id or `@channel` name.
 *
 * @returns An error message, or null when the target is valid.
 */
function validateTelegramTarget(target: string): string | null {
	const parsed = parseTelegramTarget(target);
	if (!(parsed && TELEGRAM_BOT_TOKEN.test(parsed.botToken))) {
		return "A Telegram bot token looks like 123456789:AA… (from @BotFather).";
	}
	return TELEGRAM_CHAT_ID.test(parsed.chatId)
		? null
		: "A Telegram chat id is a number like -1001234567890, or an @channel name.";
}

/**
 * Checks a browser channel's target is a push subscription's JSON: an https
 * endpoint and its `p256dh`/`auth` keys.
 *
 * @returns An error message, or null when the target is valid.
 */
function validatePushTarget(target: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(target);
	} catch {
		return "That isn't a browser push subscription.";
	}
	return pushSubscriptionSchema.safeParse(parsed).success
		? null
		: "That isn't a browser push subscription.";
}

function isDiscordWebhook(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		DISCORD_HOSTS.has(url.hostname) &&
		url.pathname.startsWith("/api/webhooks/")
	);
}

function isSlackWebhook(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		url.hostname === SLACK_HOST &&
		SLACK_PATHS.some((prefix) => url.pathname.startsWith(prefix))
	);
}

/**
 * Checks a channel's destination fits its kind : an email address, an https
 * Discord or Slack webhook URL, a Telegram bot token and chat id, a browser's
 * push subscription as JSON, or any http(s) URL for a plain webhook.
 *
 * @returns An error message, or null when the target is valid.
 */
export function validateChannelTarget(
	kind: NotificationChannelKind,
	target: string,
): string | null {
	if (kind === "browser") {
		return validatePushTarget(target);
	}
	if (kind === "telegram") {
		return validateTelegramTarget(target);
	}
	if (kind === "email") {
		return z.string().email().safeParse(target).success
			? null
			: "That doesn't look like an email address.";
	}
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return "That doesn't look like a URL.";
	}
	if (kind === "discord") {
		return isDiscordWebhook(url)
			? null
			: "A Discord webhook URL looks like https://discord.com/api/webhooks/….";
	}
	if (kind === "slack") {
		return isSlackWebhook(url)
			? null
			: "A Slack webhook URL looks like https://hooks.slack.com/services/….";
	}
	return url.protocol === "http:" || url.protocol === "https:"
		? null
		: "A webhook URL must start with http:// or https://.";
}
