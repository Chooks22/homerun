<script lang="ts">
	import { Bell, CheckCheck, Settings2, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import BrowserNotificationsButton from "#lib/components/browser-notifications-button.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import NotificationRow from "#lib/components/notification-row.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import {
		deleteAllNotifications,
		deleteNotification,
		getNotifications,
		markAllNotificationsRead,
	} from "#lib/remote/notifications.remote.js";
	import { title } from "#lib/store/title.js";
	import { toastError } from "#lib/toast.js";
	import { resolve } from "$app/paths";

	const feed = getNotifications();

	const items = $derived(feed.current?.items ?? []);
	const unreadCount = $derived(feed.current?.unreadCount ?? 0);

	onMount(() => title.set("Notifications"));

	function handleMarkAllRead() {
		return toast.promise(markAllNotificationsRead(), {
			error: (error) => toastError(error, "Couldn't mark them read."),
			loading: "Marking everything read",
			success: "All caught up.",
		});
	}

	function handleClearAll() {
		return toast.promise(deleteAllNotifications(), {
			error: (error) => toastError(error, "Couldn't clear the notifications."),
			loading: "Clearing the notifications",
			success: "Notifications cleared.",
		});
	}

	function handleDelete(id: string) {
		return toast.promise(deleteNotification(id), {
			error: (error) => toastError(error, "Couldn't delete the notification."),
			loading: "Deleting the notification",
			success: "Notification deleted.",
		});
	}
</script>

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="text-text text-lg font-semibold tracking-tight">Notifications</h1>
      <p class="text-text-muted mt-1 text-sm">
        Deploys, scheduled tasks, health and server alerts across every service,
        newest first. Each account reads and clears its own copy.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <BrowserNotificationsButton showDisable />
      {#if unreadCount > 0}
        <Button onclick={handleMarkAllRead} size="sm" variant="outline">
          <CheckCheck class="size-3.5" />
          Mark all read
        </Button>
      {/if}
      {#if items.length > 0}
        <Button onclick={handleClearAll} size="sm" variant="outline">
          <Trash2 class="size-3.5" />
          Clear all
        </Button>
      {/if}
      <Button href={resolve('notifications/settings')} size="sm" variant="outline">
        <Settings2 class="size-3.5" />
        Settings
      </Button>
    </div>
  </div>

  {#if !feed.ready}
    <div class="space-y-2">
      {#each { length: 6 }, i (i)}
        <Skeleton class="h-14 w-full" />
      {/each}
    </div>
  {:else if items.length === 0}
    <EmptyState
      icon={Bell}
      subtitle="Deploys, scheduled task summaries and alerts show up here."
      title="No notifications yet."
    />
  {:else}
    <div class="panel divide-border divide-y overflow-hidden rounded-md">
      {#each items as item (item.id)}
        <NotificationRow {item} onDelete={handleDelete} showDetail />
      {/each}
    </div>
  {/if}
</div>
