<script lang="ts">
	import { Bell } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { currentPushSubscription } from "#lib/browser-push.js";
	import { headerControlClass } from "#lib/components/header-styles.js";
	import {
		browserNotificationPermission,
		notificationHref,
	} from "#lib/notification-feed.js";
	import {
		getUnreadNotifications,
		markNotificationRead,
		type NotificationFeedItem,
	} from "#lib/remote/notifications.remote.js";
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";

	const POLL_MS = 30_000;

	const unread = getUnreadNotifications();
	const unreadCount = $derived(unread.current?.unreadCount ?? 0);

	let seen: Set<string> | null = null;
	let pushActive = false;

	$effect(() => {
		const items = unread.current?.items;
		if (!items) {
			return;
		}
		if (seen === null) {
			seen = new Set(items.map((item) => item.id));
			return;
		}
		for (const item of items) {
			if (!seen.has(item.id)) {
				seen.add(item.id);
				showBrowserNotification(item);
			}
		}
	});

	onMount(() => {
		void currentPushSubscription()
			.then((subscription) => {
				pushActive = subscription !== null;
			})
			.catch(() => null);
		const timer = setInterval(() => void unread.refresh(), POLL_MS);
		return () => clearInterval(timer);
	});

	function showBrowserNotification(item: NotificationFeedItem) {
		if (pushActive || browserNotificationPermission() !== "granted") {
			return;
		}
		const shown = new Notification(
			item.stackName ? `Homerun · ${item.stackName}` : "Homerun",
			{
				body: item.message,
				tag: item.id,
			},
		);
		shown.addEventListener("click", () => {
			window.focus();
			void markNotificationRead(item.id);
			void goto(notificationHref(item) ?? resolve("notifications"));
		});
	}
</script>

<a aria-label="Notifications" class="{headerControlClass} relative w-9 sm:w-8" href={resolve("notifications")}>
  <Bell class="size-3.5" />
  {#if unreadCount > 0}
    <span
      class="bg-accent text-bg pointer-events-none absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full text-[0.6rem] font-bold"
    >
      {unreadCount > 9 ? "9+" : unreadCount}
    </span>
  {/if}
</a>
