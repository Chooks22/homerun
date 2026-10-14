import { fail, redirect } from "@sveltejs/kit";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { Logger } from "#lib/logger.js";
import {
	channelTargetFromForm,
	notificationChannelSchema,
	validateChannelTarget,
} from "#lib/server/validation/notification-channel.js";
import { resolve } from "$app/paths";

const logger = new Logger("NotificationChannels");

export const actions = {
	default: async ({ locals, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const form = await request.formData();
		const parsed = notificationChannelSchema.safeParse({
			...Object.fromEntries(form),
			target: channelTargetFromForm(form),
		});
		if (!parsed.success) {
			return fail(400, { errors: parsed.error.flatten().fieldErrors });
		}
		const targetError = validateChannelTarget(
			parsed.data.kind,
			parsed.data.target,
		);
		if (targetError) {
			return fail(400, { errors: { target: [targetError] } });
		}

		const channel = await NotificationChannelDTO.create({
			kind: parsed.data.kind,
			name: parsed.data.name,
			target: parsed.data.target,
			userId: locals.user.id,
		});
		logger.info(
			`Notification channel created: channel=${channel.id} kind=${channel.kind} user=${locals.user.id}`,
		);
		throw redirect(303, resolve("notifications/settings/channels"));
	},
};
