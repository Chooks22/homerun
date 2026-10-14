<script lang="ts">
	import { Bot, Plus, ScrollText } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import {
		areaLabel,
		type PermissionArea,
		type Permissions,
	} from "#lib/permissions.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Service accounts"));

	function permissionSummary(permissions: Permissions): string {
		const entries = Object.entries(permissions);
		if (entries.length === 0) {
			return "Login walls only";
		}
		return entries
			.map(([area, level]) => `${areaLabel(area as PermissionArea)}: ${level}`)
			.join(", ");
	}
</script>

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Service accounts</h1>
      <p class="text-text-muted mt-1 text-sm">
        Non-human accounts for CI and scripts. They can't sign in; their API
        keys get through the login walls that list them, and reach the
        dashboard or API only where you grant it.
      </p>
    </div>
    <div class="flex gap-2">
      <Button href={resolve("service-accounts/activity")} variant="outline">
        <ScrollText class="size-4" />Activity
      </Button>
      <Button href={resolve("service-accounts/new")}>
        <Plus class="size-4" />New service account
      </Button>
    </div>
  </div>

  {#if data.accounts.length === 0}
    <EmptyState
      icon={Bot}
      subtitle="Create one to let a CI job through a pull request preview's login wall."
      title="No service accounts yet"
    >
      <Button href={resolve("service-accounts/new")}>
        <Plus class="size-4" />Create your first service account
      </Button>
    </EmptyState>
  {:else}
    <div class="space-y-2.5">
      {#each data.accounts as account (account.id)}
        <a
          class="border-border hover:bg-surface-2 flex items-center gap-3 rounded-md border p-4 transition-colors"
          href={resolve("/(protected)/service-accounts/[accountId]", { accountId: account.id })}
        >
          <div class="bg-accent/10 text-accent flex size-10 shrink-0 items-center justify-center rounded-md">
            <Bot class="size-5" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-text truncate text-sm font-medium">
              {account.name}
              {#if account.disabled}
                <span class="bg-surface-2 text-text-subtle ml-1.5 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold">
                  Disabled
                </span>
              {/if}
            </p>
            <p class="text-text-muted mt-0.5 truncate font-mono text-xs">{account.id}</p>
            <p class="text-text-subtle mt-0.5 truncate text-xs">
              {permissionSummary(account.permissions)}
            </p>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>
