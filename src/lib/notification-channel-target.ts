import type { NotificationChannelKind } from "#lib/types.js";

export interface TelegramTarget {
	botToken: string;
	chatId: string;
}

/**
 * Packs a Telegram bot token and chat id into the single `target` column a
 * channel row stores.
 */
export function formatTelegramTarget(target: TelegramTarget): string {
	return `${target.botToken.trim()}/${target.chatId.trim()}`;
}

/**
 * Splits a stored Telegram `target` back into its bot token and chat id.
 *
 * @returns Null when the value isn't a `<bot token>/<chat id>` pair.
 */
export function parseTelegramTarget(target: string): TelegramTarget | null {
	const separator = target.lastIndexOf("/");
	if (separator <= 0 || separator === target.length - 1) {
		return null;
	}
	return {
		botToken: target.slice(0, separator),
		chatId: target.slice(separator + 1),
	};
}

/**
 * The push service a browser channel's stored subscription points at, such
 * as `fcm.googleapis.com`, or null when the target isn't a subscription.
 */
export function pushServiceHost(target: string): string | null {
	try {
		const parsed: unknown = JSON.parse(target);
		const endpoint =
			parsed && typeof parsed === "object" && "endpoint" in parsed
				? parsed.endpoint
				: null;
		return typeof endpoint === "string" && URL.canParse(endpoint)
			? new URL(endpoint).hostname
			: null;
	} catch {
		return null;
	}
}

/**
 * What the dashboard shows as a channel's destination: the target itself,
 * except a Telegram channel's, which shows only the chat so the bot token
 * never reaches the browser, and a browser channel's, which shows only its
 * push service so the subscription's keys don't either.
 */
export function channelTargetLabel(
	kind: NotificationChannelKind,
	target: string,
): string {
	if (kind === "browser") {
		return `Push via ${pushServiceHost(target) ?? "unknown service"}`;
	}
	if (kind !== "telegram") {
		return target;
	}
	const parsed = parseTelegramTarget(target);
	return parsed ? `Chat ${parsed.chatId}` : "Chat unknown";
}
