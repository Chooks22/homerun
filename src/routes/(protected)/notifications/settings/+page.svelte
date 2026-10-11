<script lang="ts">
	import { BellRing, Monitor, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import BrowserNotificationsButton from "#lib/components/browser-notifications-button.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { NOTIFICATION_EVENTS } from "#lib/notification-events.js";
	import { title } from "#lib/store/title.js";
	import { saveToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Notification settings"));

	const groups = [...new Set(NOTIFICATION_EVENTS.map((info) => info.group))];
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Adds this browser as a channel, through its push service, so notifications arrive with Homerun closed. A browser without one (Helium, ungoogled-chromium) shows them only while a Homerun tab is open."
      icon={Monitor}
      title="This browser"
    >
      {#snippet trailing()}
        <BrowserNotificationsButton onchange={() => void refreshAll()} showDisable />
      {/snippet}
    </PanelHeader>
  </section>

  {#if data.channels.length === 0}
    <EmptyState
      icon={BellRing}
      subtitle="Add a Discord, Slack or Telegram channel, a generic webhook or an email address, then choose what it receives here."
      title="No notification channels yet"
    ><Button href={resolve('notifications/settings/channels')}><Plus class="size-4" />Add a channel</Button></EmptyState>
  {:else}
    <section class="panel rounded-md">
      <PanelHeader
        description="Tick an event under every channel that should receive it."
        title="What to send, and where"
      >
        {#snippet trailing()}
          <SaveButton form="notification-routing" />
        {/snippet}
      </PanelHeader>
      <form
        id="notification-routing"
        action="?/save"
        class="overflow-x-auto"
        method="POST"
        use:enhance={saveToast("Notification settings")}
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-border border-b">
              <th class="eyebrow px-5 py-3 text-left font-medium">Event</th>
              {#each data.channels as channel (channel.id)}
                <th class="text-text px-4 py-3 text-center text-xs font-medium whitespace-nowrap">
                  {channel.name}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            <tr class="bg-surface-2/50">
              <td class="eyebrow px-5 py-2" colspan={data.channels.length + 1}>
                Delivery
              </td>
            </tr>
            <tr class="border-border border-b">
              <td class="px-5 py-3">
                <p class="text-text font-medium">Group bursts</p>
                <p class="text-text-subtle text-xs">
                  Fold notifications less than a minute apart, and a scheduled
                  run's outcomes, into one message instead of one each.
                </p>
              </td>
              {#each data.channels as channel (channel.id)}
                <td class="px-4 py-3 text-center">
                  <div class="flex justify-center">
                    <Checkbox
                      aria-label="Group bursts to {channel.name}"
                      checked={channel.groupMessages}
                      name="group:{channel.id}"
                      value="on"
                    />
                  </div>
                </td>
              {/each}
            </tr>
            {#each groups as group (group)}
              <tr class="bg-surface-2/50">
                <td class="eyebrow px-5 py-2" colspan={data.channels.length + 1}>
                  {group}
                </td>
              </tr>
              {#each NOTIFICATION_EVENTS.filter((info) => info.group === group) as info (info.event)}
                <tr class="border-border border-b last:border-b-0">
                  <td class="px-5 py-3">
                    <p class="text-text font-medium">{info.label}</p>
                    <p class="text-text-subtle text-xs">{info.description}</p>
                  </td>
                  {#each data.channels as channel (channel.id)}
                    <td class="px-4 py-3 text-center">
                      <div class="flex justify-center">
                        <Checkbox
                          aria-label="{info.label} to {channel.name}"
                          checked={channel.events.includes(info.event)}
                          name="channel:{channel.id}"
                          value={info.event}
                        />
                      </div>
                    </td>
                  {/each}
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      </form>
    </section>
  {/if}
</div>
