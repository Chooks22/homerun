import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type ApiCall,
	asResult,
	change,
	read,
} from "#lib/server/mcp-tool-kit.js";
import {
	notificationChannelApiBody,
	updateNotificationChannelApiBody,
} from "#lib/server/validation/api-resources.js";

/** Registers the notification tools: the caller's in-app feed, and the channels alerts are sent to. */
export function registerNotificationTools(
	server: McpServer,
	api: ApiCall,
): void {
	const channelId = z
		.string()
		.describe("The channel's id, from list_notification_channels");
	const channelPath = (id: string) =>
		`/notification-channels/${encodeURIComponent(id)}`;

	server.registerTool(
		"list_notifications",
		{
			annotations: read,
			description:
				"The caller's in-app notifications (the dashboard's bell), newest first: deploys that failed or rolled back, unhealthy revisions, app errors, resource alerts, failed scheduled jobs and the like, each with its type, message, detail, service and when it was read.",
			inputSchema: z.object({
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe("How many to return (default 50)"),
				unread: z.boolean().optional().describe("Only the unread ones"),
			}),
		},
		async ({ limit, unread }) => {
			const query = new URLSearchParams();
			if (limit) {
				query.set("limit", String(limit));
			}
			if (unread) {
				query.set("unread", "true");
			}
			return asResult(await api("GET", `/notifications?${query}`));
		},
	);

	server.registerTool(
		"mark_notifications_read",
		{
			annotations: change,
			description:
				"Mark one of the caller's notifications read, or all of them when no id is given.",
			inputSchema: z.object({
				id: z
					.string()
					.optional()
					.describe("The notification's id, from list_notifications"),
			}),
		},
		async ({ id }) =>
			asResult(await api("POST", "/notifications/read", id ? { id } : {})),
	);

	server.registerTool(
		"list_notification_channels",
		{
			annotations: read,
			description:
				"List the caller's notification channels (webhook, Discord, Slack, Telegram, email, browser): the events each one gets, whether it's on, where it delivers without the secret part, and its last delivery error.",
		},
		async () => asResult(await api("GET", "/notification-channels")),
	);

	server.registerTool(
		"create_notification_channel",
		{
			annotations: change,
			description:
				"Add a notification channel that alerts and deploy notifications are sent to.",
			inputSchema: notificationChannelApiBody,
		},
		async (input) =>
			asResult(await api("POST", "/notification-channels", input)),
	);

	server.registerTool(
		"update_notification_channel",
		{
			annotations: change,
			description:
				"Change a notification channel's name, events, target or grouping, keeping what's left out. enabled: false pauses it.",
			inputSchema: updateNotificationChannelApiBody.extend({ channelId }),
		},
		async ({ channelId: id, ...changes }) =>
			asResult(await api("PATCH", channelPath(id), changes)),
	);

	server.registerTool(
		"delete_notification_channel",
		{
			annotations: { destructiveHint: true, openWorldHint: false },
			description: "Delete a notification channel.",
			inputSchema: z.object({ channelId }),
		},
		async ({ channelId: id }) => asResult(await api("DELETE", channelPath(id))),
	);
}
