import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { apiCaller, readApiBody } from "#lib/server/api-route.js";
import { markNotificationsReadApiBody } from "#lib/server/validation/api.js";

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, markNotificationsReadApiBody);
	if ("response" in body) {
		return body.response;
	}
	if (body.data.id) {
		await NotificationDTO.markRead(body.data.id, caller.userId);
	} else {
		await NotificationDTO.markAllRead(caller.userId);
	}
	return Response.json({ success: true });
};
