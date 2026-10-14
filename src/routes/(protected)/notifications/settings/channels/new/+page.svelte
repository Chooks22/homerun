<script lang="ts">
	import { ArrowLeft, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import type { NotificationChannelKind } from "#lib/types.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { form } = $props();

	onMount(() => title.set("New notification channel"));

	let channelKind = $state<NotificationChannelKind>("discord");
	const kindOptions: { label: string; value: NotificationChannelKind }[] = [
		{ label: "Discord", value: "discord" },
		{ label: "Slack", value: "slack" },
		{ label: "Telegram", value: "telegram" },
		{ label: "Webhook", value: "webhook" },
		{ label: "Email", value: "email" },
	];
	let creating = $state(false);

	const TARGET_PLACEHOLDER: Record<NotificationChannelKind, string> = {
		browser: "",
		discord: "https://discord.com/api/webhooks/…",
		email: "oncall@example.com",
		slack: "https://hooks.slack.com/services/…",
		telegram: "",
		webhook: "https://hooks.example.com/…",
	};
</script>

<div class="space-y-6">
  <a
    class="text-text-muted hover:text-text inline-flex items-center gap-1 text-sm"
    href={resolve("/(protected)/notifications/settings/channels")}
  >
    <ArrowLeft class="size-4" />
    All channels
  </a>

  <section class="panel rounded-md">
    <div class="panel-head">
      <h2 class="eyebrow flex shrink-0 items-center gap-1.5">
        <Plus class="size-3" />
        New channel
      </h2>
      <span class="text-text-subtle text-right text-[0.6875rem]">
        New channels get build and update failures by default
      </span>
    </div>
    <form
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't add the channel.",
        loading: "Adding the channel",
        onSettled: () => {
          creating = false;
        },
        onStart: () => {
          creating = true;
        },
        success: "Channel added.",
      })}
    >
      <div class="grid gap-4 md:grid-cols-3">
        <div>
          <label class={label} for="channelName">Name</label>
          <Input id="channelName" name="name" placeholder="On-call Discord" />
        </div>
        <div>
          <label class={label} for="channelKind">Kind</label>
          <Select.Root name="kind" type="single" bind:value={channelKind}>
            <Select.Trigger class="w-full" id="channelKind">
              {kindOptions.find((option) => option.value === channelKind)
                ?.label}
            </Select.Trigger>
            <Select.Content>
              {#each kindOptions as option (option.value)}
                <Select.Item label={option.label} value={option.value} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        {#if channelKind === "telegram"}
          <div>
            <label class={label} for="telegramBotToken">Bot token</label>
            <Input
              autocomplete="off"
              id="telegramBotToken"
              name="telegramBotToken"
              placeholder="123456789:AA…"
              type="password"
            />
          </div>
        {:else}
          <div>
            <label class={label} for="channelTarget">
              {channelKind === "email" ? "Address" : "Webhook URL"}
            </label>
            <Input
              id="channelTarget"
              name="target"
              placeholder={TARGET_PLACEHOLDER[channelKind]}
            />
          </div>
        {/if}
      </div>
      {#if channelKind === "telegram"}
        <div class="grid gap-4 md:grid-cols-3">
          <div class="md:col-start-3">
            <label class={label} for="telegramChatId">Chat id</label>
            <Input
              id="telegramChatId"
              name="telegramChatId"
              placeholder="-1001234567890 or @channel"
            />
          </div>
        </div>
        <p class="text-text-subtle text-xs">
          Create a bot with @BotFather, add it to the chat, and use the chat's
          numeric id (or a public channel's @name).
        </p>
      {/if}
      {#if form?.errors && "target" in form.errors && form.errors.target}
        <p class="text-xs text-red-500">{form.errors.target[0]}</p>
      {/if}
      <div class="flex justify-end">
        <Button disabled={creating} type="submit">
          <Plus class="size-4" />
          Add channel
        </Button>
      </div>
    </form>
  </section>
</div>
