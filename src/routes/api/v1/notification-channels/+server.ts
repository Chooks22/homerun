import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { isNotificationEvent } from "#lib/notification-events.js";
import { notificationChannelApiJson } from "#lib/server/api-json.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { notificationChannelApiBody } from "#lib/server/validation/api-resources.js";
import { validateChannelTarget } from "#lib/server/validation/notification-channel.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(
		(await NotificationChannelDTO.list(caller.userId)).map((channel) =>
			notificationChannelApiJson(channel.toJSON()),
		),
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, notificationChannelApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { enabled, events, groupMessages, kind, name, target } = body.data;
	const targetError = validateChannelTarget(kind, target);
	if (targetError) {
		return apiError(targetError);
	}
	const channel = await NotificationChannelDTO.create({
		enabled,
		events: events?.filter(isNotificationEvent),
		groupMessages,
		kind,
		name,
		target,
		userId: caller.userId,
	});
	return Response.json(notificationChannelApiJson(channel.toJSON()), {
		status: 201,
	});
};
