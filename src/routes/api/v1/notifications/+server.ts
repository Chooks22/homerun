import {
	MAX_ROWS_PER_USER,
	NotificationDTO,
} from "#lib/dto/notification-dto.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const limit = Number(url.searchParams.get("limit") ?? 50);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS_PER_USER) {
		return apiError(
			`limit must be a whole number from 1 to ${MAX_ROWS_PER_USER}.`,
		);
	}
	const rows = await NotificationDTO.listForUser(
		caller.userId,
		limit,
		url.searchParams.get("unread") === "true",
	);
	return Response.json(
		rows.map(({ notification, serviceSlug, stackName }) => {
			const { userId: _owner, ...row } = notification.toJSON();
			return { ...row, serviceSlug, stackName };
		}),
	);
};
