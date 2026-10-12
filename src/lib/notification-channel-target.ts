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

/** The endpoint URL of a browser channel's stored subscription, or null when the target isn't a subscription. */
export function pushEndpoint(target: string): string | null {
	try {
		const parsed: unknown = JSON.parse(target);
		const endpoint =
			parsed && typeof parsed === "object" && "endpoint" in parsed
				? parsed.endpoint
				: null;
		return typeof endpoint === "string" && URL.canParse(endpoint)
			? endpoint
			: null;
	} catch {
		return null;
	}
}

/**
 * The push service a browser channel's stored subscription points at, such
 * as `fcm.googleapis.com`, or null when the target isn't a subscription.
 */
export function pushServiceHost(target: string): string | null {
	const endpoint = pushEndpoint(target);
	return endpoint ? new URL(endpoint).hostname : null;
}

/**
 * A SHA-256 digest of a push endpoint, hex-encoded, so a page can tell which
 * browser channel belongs to the browser viewing it without the endpoint
 * itself leaving the server.
 */
export async function pushEndpointDigest(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(endpoint),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
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
