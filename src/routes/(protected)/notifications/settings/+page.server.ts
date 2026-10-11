import { redirect } from "@sveltejs/kit";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { Logger } from "#lib/logger.js";
import { isNotificationEvent } from "#lib/notification-events.js";
import { resolve } from "$app/paths";

const logger = new Logger("NotificationSettings");

export const load = async ({ parent }) => {
	const { user } = await parent();
	const channels = await NotificationChannelDTO.list(user.id);
	return {
		channels: channels.map((channel) => ({
			events: channel.events,
			groupMessages: channel.groupMessages,
			id: channel.id,
			kind: channel.kind,
			name: channel.name,
		})),
	};
};

export const actions = {
	save: async ({ locals, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const form = await request.formData();
		const channels = await NotificationChannelDTO.list(locals.user.id);
		await Promise.all(
			channels.map((channel) =>
				channel.update({
					events: form
						.getAll(`channel:${channel.id}`)
						.filter((value) => typeof value === "string")
						.filter(isNotificationEvent),
					groupMessages: form.get(`group:${channel.id}`) === "on",
				}),
			),
		);
		logger.info(`Notification settings saved: user=${locals.user.id}`);
		return { success: true };
	},
};
