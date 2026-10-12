<script lang="ts">
	import { Plus, ShieldCheck, Siren, Trash2 } from "@lucide/svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { formatDate, timeAgo } from "#lib/formatting.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();
</script>

<div class="space-y-6">
  {#if !data.view}
    <EmptyState
      icon={ShieldCheck}
      subtitle="Connect a CrowdSec Local API under Settings → IP bans to see and manage its decisions here."
      title="CrowdSec isn't set up"
    >
      <Button href={resolve("/(protected)/settings/ip-bans")} size="sm" variant="outline">
        Set it up
      </Button>
    </EmptyState>
  {:else}
    <section class="panel rounded-md">
      <PanelHeader
        description="What CrowdSec's bouncers enforce right now, community blocklist aside. Bans Homerun pushed are marked."
        icon={ShieldCheck}
        title="Active decisions"
      >
        {#snippet trailing()}
          {#if data.canWrite}
            <Button href={resolve("/(protected)/monitoring/crowdsec/new")} size="sm">
              <Plus class="size-4" />
              New decision
            </Button>
          {/if}
        {/snippet}
      </PanelHeader>
      {#await data.view}
        <div class="space-y-2 p-5">
          <Skeleton class="h-6 w-full" />
          <Skeleton class="h-6 w-2/3" />
        </div>
      {:then view}
        {#if view.error}
          <p class="text-text-muted px-5 py-4 text-sm">{view.error}</p>
        {:else if view.decisions.length === 0}
          <p class="text-text-muted px-5 py-4 text-sm">No decision in force.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
                  <th class="px-4 py-3 font-medium">Value</th>
                  <th class="px-4 py-3 font-medium">Reason</th>
                  <th class="hidden px-4 py-3 font-medium md:table-cell">Origin</th>
                  <th class="px-4 py-3 font-medium">Until</th>
                  {#if data.canWrite}
                    <th class="px-4 py-3"></th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each view.decisions as decision (decision.id)}
                  <tr class="border-border/60 border-b last:border-0">
                    <td class="px-4 py-3">
                      <p class="text-text font-mono">{decision.value}</p>
                      {#if decision.country || decision.asName}
                        <p class="text-text-subtle text-xs">
                          {[decision.country, decision.asName].filter(Boolean).join(" · ")}
                        </p>
                      {/if}
                    </td>
                    <td class="text-text-muted px-4 py-3 break-all">
                      {#if decision.fromHomerun}
                        <span class="bg-accent/10 text-accent mr-1.5 rounded px-1.5 py-0.5 text-xs font-medium">
                          Homerun
                        </span>
                      {/if}
                      {decision.scenario}
                      {#if decision.type !== "ban"}
                        <span class="text-text-subtle text-xs">({decision.type})</span>
                      {/if}
                    </td>
                    <td class="text-text-muted hidden px-4 py-3 md:table-cell">{decision.origin}</td>
                    <td class="text-text-muted px-4 py-3" title={new Date(decision.expiresAt).toLocaleString()}>
                      {formatDate(new Date(decision.expiresAt))}
                    </td>
                    {#if data.canWrite}
                      <td class="px-4 py-3 text-right">
                        <form
                          action="?/deleteDecision"
                          method="POST"
                          use:enhance={enhanceToast({
                            error: "Couldn't delete that decision.",
                            loading: `Deleting the decision on ${decision.value}`,
                            success: `Decision on ${decision.value} deleted.`,
                          })}
                        >
                          <input name="id" type="hidden" value={decision.id}>
                          <Button size="sm" type="submit" variant="outline">
                            <Trash2 class="size-4" />
                            Delete
                          </Button>
                        </form>
                      </td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if view.truncated}
            <p class="text-text-subtle border-border border-t px-5 py-3 text-xs">
              Only the newest {view.decisions.length} decisions are shown: the LAPI holds more.
            </p>
          {/if}
        {/if}
      {/await}
    </section>

    <section class="panel rounded-md">
      <PanelHeader
        description="What CrowdSec's scenarios caught in the last 24 hours."
        icon={Siren}
        title="Recent alerts"
      />
      {#await data.view}
        <div class="p-5"><Skeleton class="h-6 w-full" /></div>
      {:then view}
        {#if view.alerts.length === 0}
          <p class="text-text-muted px-5 py-4 text-sm">
            {view.error ? "Couldn't read the alerts." : "No alert in the last 24 hours."}
          </p>
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
                {#each view.alerts as alert (alert.id)}
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
        {/if}
      {/await}
    </section>
  {/if}
</div>
