<script lang="ts">
	import { ArrowLeft, KeyRound, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import {
		API_KEY_EXPIRY_OPTIONS,
		type ApiKeyExpiry,
		DEFAULT_API_KEY_EXPIRY,
	} from "#lib/permissions.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set(`${data.account.name} · New API key`));

	const keysHref = $derived(
		resolve("/(protected)/service-accounts/[accountId]", {
			accountId: data.account.id,
		}),
	);
	let expiry = $state<ApiKeyExpiry>(DEFAULT_API_KEY_EXPIRY);
	const expiryLabel = $derived(
		API_KEY_EXPIRY_OPTIONS.find((option) => option.value === expiry)?.label ??
			"",
	);
	let creating = $state(false);
</script>

{#if form?.success && "key" in form && form.key}
  <div class="space-y-4">
    <div class="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900/40 dark:bg-emerald-950/20">
      <p class="font-semibold text-emerald-800 dark:text-emerald-400">API key created</p>
      <p class="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
        Copy it now and store it as a CI secret: it won't be shown again.
      </p>
      <CopyBox
        class="mt-2 border-emerald-200 bg-surface dark:border-emerald-900/40"
        label="the API key"
        value={form.key}
      />
    </div>
    <Button href={keysHref} variant="outline">
      <ArrowLeft class="size-4" />
      Back to API keys
    </Button>
  </div>
{:else}
  <section class="panel rounded-md">
    <PanelHeader
      description="The key does exactly what the service account may do, no more."
      icon={KeyRound}
      title="New API key"
    />
    <form
      action="?/create"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't create the key.",
        loading: "Creating the key",
        onSettled: () => {
          creating = false;
        },
        onStart: () => {
          creating = true;
        },
        success: "Key created.",
      })}
    >
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-48 flex-1">
          <label class="text-text mb-1.5 block text-sm font-medium" for="name">Name</label>
          <Input id="name" name="name" placeholder="e.g. GitHub Actions" type="text" />
        </div>
        <div>
          <div class="text-text mb-1.5 block text-sm font-medium">Expires</div>
          <Select.Root name="expiry" type="single" bind:value={expiry}>
            <Select.Trigger aria-label="Expires" class="w-52">{expiryLabel}</Select.Trigger>
            <Select.Content>
              {#each API_KEY_EXPIRY_OPTIONS as option (option.value)}
                <Select.Item label={option.label} value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if expiry === "never"}
        <Alert variant="warning">
          A key that never expires keeps working until you revoke it. Set an
          expiry unless something can't rotate it.
        </Alert>
      {/if}

      <div class="flex justify-end">
        <Button disabled={creating} type="submit">
          {#if creating}
            <Spinner />
          {:else}
            <Plus class="size-4" />
          {/if}
          Generate
        </Button>
      </div>
    </form>
  </section>
{/if}
