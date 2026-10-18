import { fail } from "@sveltejs/kit";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { Logger } from "#lib/logger.js";
import {
	channelTargetLabel,
	parseTelegramTarget,
} from "#lib/notification-channel-target.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	channelTargetFromForm,
	notificationChannelSchema,
	validateChannelTarget,
} from "#lib/server/validation/notification-channel.js";
import { NotificationChannelService } from "#lib/services/notification-channel.service.js";

const logger = new Logger("NotificationChannels");

export const load = async ({ parent }) => {
	const { user } = await parent();
	const channels = await NotificationChannelDTO.list(user.id);
	return {
		channels: channels.map((channel) => ({
			...channel.toJSON(),
			target: channelTargetLabel(channel.kind, channel.target),
			telegramChatId:
				channel.kind === "telegram"
					? (parseTelegramTarget(channel.target)?.chatId ?? "")
					: null,
		})),
	};
};

export const actions = {
	updateChannel: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const form = await request.formData();
		const id = form.get("channelId");
		if (typeof id !== "string" || !id) {
			return fail(400, { error: "Missing channel id." });
		}
		const channel = await NotificationChannelDTO.get(id, locals.user.id);
		if (!channel) {
			return fail(404, { error: "Channel not found." });
		}
		const parsed = notificationChannelSchema.safeParse({
			kind: channel.kind,
			name: form.get("name"),
			target: channelTargetFromForm(form, channel),
		});
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message });
		}
		const targetError = validateChannelTarget(
			parsed.data.kind,
			parsed.data.target,
		);
		if (targetError) {
			return fail(400, { error: targetError });
		}

		await channel.update({
			enabled: form.get("enabled") === "on",
			lastError: null,
			name: parsed.data.name,
			target: parsed.data.target,
		});
		logger.info(
			`Notification channel updated: channel=${id} user=${locals.user.id}`,
		);
		return { success: true };
	},

	deleteChannel: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const form = await request.formData();
		const id = form.get("channelId");
		if (typeof id !== "string" || !id) {
			return fail(400, { error: "Missing channel id." });
		}
		const channel = await NotificationChannelDTO.get(id, locals.user.id);
		if (!channel) {
			return fail(404, { error: "Channel not found." });
		}
		await channel.delete();
		logger.info(
			`Notification channel deleted: channel=${id} user=${locals.user.id}`,
		);
		return { success: true };
	},

	testChannel: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const form = await request.formData();
		const id = form.get("channelId");
		if (typeof id !== "string" || !id) {
			return fail(400, { error: "Missing channel id." });
		}
		const channel = await NotificationChannelDTO.get(id, locals.user.id);
		if (!channel) {
			return fail(404, { error: "Channel not found." });
		}
		try {
			await NotificationChannelService.sendTest(channel);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`Test notification failed: channel=${id} : ${message}`);
			await channel.update({ lastError: message });
			return fail(502, {
				error: `Couldn't send the test notification : ${message}`,
			});
		}
		return { success: true };
	},
};
