<script lang="ts">
	import { Siren } from "@lucide/svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { timeAgo } from "#lib/formatting.js";

	const { data } = $props();
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="What CrowdSec's scenarios caught in the last 24 hours, the community blocklist's updates aside."
    icon={Siren}
    title="Recent alerts"
  />
  {#await data.alerts}
    <div class="p-5"><Skeleton class="h-6 w-full" /></div>
  {:then alerts}
    {#if alerts?.error}
      <p class="text-text-muted px-5 py-4 text-sm">{alerts.error}</p>
    {:else if !alerts?.total}
      <p class="text-text-muted px-5 py-4 text-sm">No alert in the last 24 hours.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
              <th class="px-4 py-3 font-medium">Source</th>
              <th class="px-4 py-3 font-medium">Scenario</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">Events</th>
              <th class="px-4 py-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {#each alerts.items as alert (alert.id)}
              <tr class="border-border/60 border-b last:border-0">
                <td class="px-4 py-3">
                  <p class="text-text font-mono">{alert.value}</p>
                  {#if alert.country || alert.asName}
                    <p class="text-text-subtle text-xs">
                      {[alert.country, alert.asName].filter(Boolean).join(" · ")}
                    </p>
                  {/if}
                </td>
                <td class="text-text-muted px-4 py-3 break-all">{alert.scenario}</td>
                <td class="text-text-muted hidden px-4 py-3 tabular-nums md:table-cell">
                  {alert.eventsCount}
                </td>
                <td class="text-text-muted px-4 py-3" title={alert.at ? new Date(alert.at).toLocaleString() : ""}>
                  {alert.at ? timeAgo(alert.at) : ""}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="px-5 pb-5">
        <Pagination label="alerts" page={data.page} perPage={data.perPage} total={alerts.total} />
      </div>
    {/if}
  {/await}
</section>
