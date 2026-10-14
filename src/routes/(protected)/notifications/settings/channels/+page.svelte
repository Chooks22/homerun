<script lang="ts">
	import {
		BellRing,
		Hash,
		Mail,
		MessageCircle,
		Monitor,
		Pencil,
		Plus,
		Send,
		Trash2,
		Webhook,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import ResponsiveDialog from "#lib/components/responsive-dialog.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Switch } from "#lib/components/ui/switch/index.js";
	import { NOTIFICATION_EVENTS } from "#lib/notification-events.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import type { NotificationChannelKind } from "#lib/types.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Notification channels"));

	let editOpen = $state(false);
	let editing = $state<(typeof data.channels)[number] | null>(null);

	function requestEdit(channel: (typeof data.channels)[number]) {
		editing = channel;
		editOpen = true;
	}

	let deleteDialogOpen = $state(false);
	let pendingDeleteName = $state("");
	let pendingDeleteForm: HTMLFormElement | null = null;

	function requestDelete(event: MouseEvent, name: string) {
		pendingDeleteForm = (event.currentTarget as HTMLElement).closest("form");
		pendingDeleteName = name;
		deleteDialogOpen = true;
	}

	const KIND_LABEL: Record<NotificationChannelKind, string> = {
		browser: "Browser",
		discord: "Discord",
		email: "Email",
		slack: "Slack",
		telegram: "Telegram",
		webhook: "Webhook",
	};

	const TARGET_PLACEHOLDER: Record<NotificationChannelKind, string> = {
		browser: "",
		discord: "https://discord.com/api/webhooks/…",
		email: "oncall@example.com",
		slack: "https://hooks.slack.com/services/…",
		telegram: "",
		webhook: "https://hooks.example.com/…",
	};

	function eventSummary(events: string[]): string {
		const labels = NOTIFICATION_EVENTS.filter((info) =>
			events.includes(info.event),
		).map((info) => info.label);
		return labels.length === 0 ? "No events" : labels.join(", ");
	}
</script>

<div>
  {#if data.channels.length === 0}
    <EmptyState
      icon={BellRing}
      subtitle="Add a Discord, Slack or Telegram channel, a generic webhook or an email address, or turn on browser notifications under General."
      title="No notification channels yet"
    ><Button href={resolve("/(protected)/notifications/settings/channels/new")}><Plus class="size-4" />New channel</Button></EmptyState>
  {:else}
    <section class="panel rounded-md">
      <div class="panel-head">
        <h2 class="eyebrow flex items-center gap-1.5">
          <Send class="size-3" />
          Channels
        </h2>
        <Button
          href={resolve("/(protected)/notifications/settings/channels/new")}
          size="sm"
        >
          <Plus class="size-4" />
          New channel
        </Button>
      </div>
      <div class="divide-border divide-y">
        {#each data.channels as channel (channel.id)}
          <div class="flex flex-wrap items-center gap-3 px-5 py-3">
            {#if channel.kind === "webhook"}
              <Webhook class="text-text-muted size-4 shrink-0" />
            {:else if channel.kind === "discord"}
              <MessageCircle class="text-text-muted size-4 shrink-0" />
            {:else if channel.kind === "slack"}
              <Hash class="text-text-muted size-4 shrink-0" />
            {:else if channel.kind === "telegram"}
              <Send class="text-text-muted size-4 shrink-0" />
            {:else if channel.kind === "browser"}
              <Monitor class="text-text-muted size-4 shrink-0" />
            {:else}
              <Mail class="text-text-muted size-4 shrink-0" />
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-text truncate text-sm font-medium">
                {channel.name}
                <span class="text-text-subtle ml-1 text-xs font-normal">
                  {KIND_LABEL[channel.kind]}
                </span>
                {#if !channel.enabled}
                  <span class="text-text-subtle ml-1 text-xs font-normal">
                    · Disabled
                  </span>
                {/if}
              </p>
              <p class="text-text-subtle truncate text-xs">{channel.target}</p>
              <p class="text-text-muted truncate text-xs">
                {eventSummary(channel.events)}
              </p>
              {#if channel.lastError}
                <p class="truncate text-xs text-red-500">{channel.lastError}</p>
              {/if}
            </div>
            <div class="flex w-full items-center gap-3 pl-7 sm:w-auto sm:pl-0">
              <form
                action="?/testChannel"
                method="POST"
                use:enhance={enhanceToast({
                  error: "Couldn't send the test notification.",
                  loading: "Sending a test notification",
                  success: "Test notification sent.",
                })}
              >
                <input name="channelId" type="hidden" value={channel.id} />
                <Button size="sm" type="submit" variant="outline">Send test</Button>
              </form>
              <Button
                aria-label="Edit {channel.name}"
                onclick={() => requestEdit(channel)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Pencil class="size-4" />
              </Button>
              <form
                action="?/deleteChannel"
                method="POST"
                use:enhance={enhanceToast({
                  error: "Couldn't remove the channel.",
                  loading: "Removing the channel",
                  success: "Channel removed.",
                })}
              >
                <input name="channelId" type="hidden" value={channel.id} />
                <Button
                  aria-label="Remove {channel.name}"
                  class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
                  onclick={(event) => requestDelete(event, channel.name)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 class="size-4" />
                </Button>
              </form>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<ResponsiveDialog
  size="sm"
  title="Edit {editing?.name ?? 'channel'}"
  bind:open={editOpen}
>
  {#if editing}
    <form
      action="?/updateChannel"
      class="space-y-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the channel.",
        loading: "Saving the channel",
        onSuccess: () => {
          editOpen = false;
        },
        success: "Channel saved.",
      })}
    >
      <input name="channelId" type="hidden" value={editing.id} />
      <div>
        <label class={label} for="editChannelName">Name</label>
        <Input id="editChannelName" name="name" value={editing.name} />
      </div>
      {#if editing.kind === "telegram"}
        <div>
          <label class={label} for="editTelegramBotToken">Bot token</label>
          <Input
            autocomplete="off"
            id="editTelegramBotToken"
            name="telegramBotToken"
            placeholder="Leave blank to keep the current token"
            type="password"
          />
        </div>
        <div>
          <label class={label} for="editTelegramChatId">Chat id</label>
          <Input
            id="editTelegramChatId"
            name="telegramChatId"
            value={editing.telegramChatId ?? ""}
          />
        </div>
      {:else if editing.kind !== "browser"}
        <div>
          <label class={label} for="editChannelTarget">
            {editing.kind === "email" ? "Address" : "Webhook URL"}
          </label>
          <Input
            id="editChannelTarget"
            name="target"
            placeholder={TARGET_PLACEHOLDER[editing.kind]}
            value={editing.target}
          />
        </div>
      {/if}
      <label class="flex items-center gap-2 text-sm" for="editChannelEnabled">
        <Switch
          checked={editing.enabled}
          id="editChannelEnabled"
          name="enabled"
        />
        Enabled
      </label>
      <div class="flex justify-end">
        <Button type="submit">Save</Button>
      </div>
    </form>
  {/if}
</ResponsiveDialog>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Remove"
  description={`Remove "${pendingDeleteName}"? It stops receiving notifications.`}
  onConfirm={() => pendingDeleteForm?.requestSubmit()}
  title="Remove notification channel"
/>
