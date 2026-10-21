<script lang="ts">
	import { ShieldBan } from "@lucide/svelte";
	import { onMount } from "svelte";
	import BlockedSummary from "#lib/components/blocked-summary.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { timeAgo } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set(`${data.service.name} · Blocked IPs`));
</script>

<div class="space-y-6">
  {#if data.blockedPaths.length === 0}
    <p class="text-text-muted text-sm">
      This service blocks no paths, so nothing gets turned away.
      <a
        class="text-accent hover:underline"
        href={`${resolve("/(protected)/services/[serviceId]/security", { serviceId: data.service.id })}#blocked-paths`}
      >
        Add blocked paths
      </a>
    </p>
  {/if}

  <BlockedSummary baiting={data.baiting} days={data.statsDays} summary={data.summary} />

  <section class="panel rounded-md">
    <PanelHeader
      description={`Addresses that requested this service's blocked paths in the last ${data.statsDays} days, most recent first.`}
      icon={ShieldBan}
      title="Blocked addresses"
    >
      {#snippet trailing()}
        {#if data.canManageBans}
          <a
            class="text-accent shrink-0 text-sm hover:underline"
            href={resolve("/(protected)/monitoring/blocked")}
          >
            Manage bans
          </a>
        {/if}
      {/snippet}
    </PanelHeader>
    {#if data.addresses.length === 0}
      <div class="p-5">
        <EmptyState
          icon={ShieldBan}
          subtitle="Scanners poking at this service's blocked paths show up here."
          title="Nobody blocked yet"
        />
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
              <th class="px-4 py-3 font-medium">Address</th>
              <th class="px-4 py-3 font-medium">Requests</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">Last asked for</th>
              <th class="px-4 py-3 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {#each data.addresses as address (address.ip)}
              <tr class="border-border/60 border-b last:border-0">
                <td class="text-text px-4 py-3 font-mono">
                  {address.ip}
                  {#if address.banned}
                    <span class="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 font-sans text-[0.65rem] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      Banned
                    </span>
                  {/if}
                </td>
                <td class="text-text-muted px-4 py-3 tabular-nums">{address.hits}</td>
                <td class="text-text-muted hidden px-4 py-3 font-mono text-xs break-all md:table-cell">
                  {address.path ?? ""}
                </td>
                <td class="text-text-muted px-4 py-3" title={new Date(address.lastAt).toLocaleString()}>
                  {timeAgo(address.lastAt)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
