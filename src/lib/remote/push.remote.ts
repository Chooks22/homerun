import { z } from "zod";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { Logger } from "#lib/logger.js";
import { DEFAULT_BROWSER_EVENTS } from "#lib/notification-events.js";
import { requireUser } from "#lib/server/remote-auth.js";
import { pushSubscriptionSchema } from "#lib/server/web-push.js";
import { WebPushService } from "#lib/services/web-push.service.js";
import { command, query } from "$app/server";

const logger = new Logger("WebPush");

/** The user's browser channel whose stored subscription has `endpoint`, if any. */
async function browserChannelFor(
	userId: string,
	endpoint: string,
): Promise<NotificationChannelDTO | null> {
	const channels = await NotificationChannelDTO.list(userId);
	return (
		channels.find((channel) => {
			if (channel.kind !== "browser") {
				return false;
			}
			try {
				return JSON.parse(channel.target).endpoint === endpoint;
			} catch {
				return false;
			}
		}) ?? null
	);
}

export const getPushPublicKey = query(async (): Promise<string> => {
	requireUser();
	return await WebPushService.publicKey();
});

export const registerBrowserPush = command(
	z.object({
		name: z.string().trim().min(1).max(100),
		subscription: pushSubscriptionSchema,
	}),
	async ({ name, subscription }): Promise<{ channelId: string }> => {
		const user = requireUser();
		const target = JSON.stringify({
			endpoint: subscription.endpoint,
			keys: subscription.keys,
		});
		const existing = await browserChannelFor(user.id, subscription.endpoint);
		if (existing) {
			await existing.update({ enabled: true, lastError: null, target });
			return { channelId: existing.id };
		}
		const channel = await NotificationChannelDTO.create({
			events: [...DEFAULT_BROWSER_EVENTS],
			kind: "browser",
			name,
			target,
			userId: user.id,
		});
		logger.info(
			`Browser push channel created: channel=${channel.id} user=${user.id}`,
		);
		return { channelId: channel.id };
	},
);

export const unregisterBrowserPush = command(
	z.string().url(),
	async (endpoint): Promise<void> => {
		const user = requireUser();
		const channel = await browserChannelFor(user.id, endpoint);
		if (channel) {
			await channel.delete();
			logger.info(
				`Browser push channel removed: channel=${channel.id} user=${user.id}`,
			);
		}
	},
);
