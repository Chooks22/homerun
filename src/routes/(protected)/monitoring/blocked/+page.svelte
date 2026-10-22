<script lang="ts">
	import { Ban, Radar, Undo2 } from "@lucide/svelte";
	import BlockedSummary from "#lib/components/blocked-summary.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { formatDate, timeAgo } from "#lib/formatting.js";
	import { intelSummary } from "#lib/ip-intel.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();
</script>

<div class="space-y-6">
  {#if !data.published}
    <p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
      Traefik's dynamic config directory isn't set (Settings → Networking), so
      blocked requests aren't counted and bans aren't enforced.
    </p>
  {:else if !data.ipBans.enabled}
    <p class="text-text-muted text-sm">
      Bans are off: blocked paths still answer 403, but nobody gets banned.
      <a
        class="text-accent hover:underline"
        href={resolve("/(protected)/settings/ip-bans")}
      >
        Turn them on
      </a>
    </p>
  {/if}

  <BlockedSummary
    baiting={data.ipBans.meanMode || data.ipBans.disrespectMode}
    bans={data.bans.length}
    days={data.statsDays}
    summary={data.summary}
  />

  <section class="panel rounded-md">
    <PanelHeader
      description="Addresses Traefik turns away with a 403 on every service. Notification channels subscribed to IP banned hear about each new one."
      icon={Ban}
      title="Banned addresses"
    />
    <div class="p-5">
      {#if data.bans.length === 0}
        <EmptyState
          icon={Ban}
          subtitle="Addresses that keep requesting blocked paths show up here."
          title="Nobody is banned"
        />
      {:else}
        <div class="space-y-2.5">
          {#each data.bans as ban (ban.ip)}
            <div class="border-border flex items-center gap-4 rounded-md border p-4">
              <div class="min-w-0 flex-1">
                <p class="text-text truncate font-mono text-sm font-medium">
                  {ban.ip}
                </p>
                <p class="text-text-muted mt-0.5 truncate text-xs">
                  {ban.reason}{ban.host ? ` on ${ban.host}` : ""}
                </p>
                <p class="text-text-muted mt-0.5 truncate text-xs">
                  {#if !ban.intel}
                    Looking up who this is…
                  {:else}
                    {intelSummary(ban.intel) ?? "Nothing known about this address"}{ban.intel.networkName ? ` · ${ban.intel.networkName}` : ""}{ban.intel.network ? ` (${ban.intel.network})` : ""}
                  {/if}
                </p>
                {#if ban.intel?.abuseEmail}
                  <p class="text-text-muted mt-0.5 truncate text-xs">
                    Abuse contact:
                    <a
                      class="text-accent hover:underline"
                      href={`mailto:${ban.intel.abuseEmail}`}
                    >
                      {ban.intel.abuseEmail}
                    </a>
                  </p>
                {/if}
                {#if ban.userAgent}
                  <p class="text-text-subtle mt-0.5 truncate font-mono text-xs" title={ban.userAgent}>
                    {ban.userAgent}
                  </p>
                {/if}
                <p class="text-text-subtle mt-0.5 text-xs">
                  banned {timeAgo(ban.createdAt)} ·
                  {ban.expiresAt
                    ? `until ${formatDate(ban.expiresAt)} ${new Date(ban.expiresAt).toLocaleTimeString()}`
                    : "for good"}
                </p>
              </div>
              <form
                action="?/unban"
                method="POST"
                use:enhance={enhanceToast({
                  error: "Couldn't lift that ban.",
                  loading: `Unbanning ${ban.ip}`,
                  success: `${ban.ip} unbanned.`,
                })}
              >
                <input name="ip" type="hidden" value={ban.ip}>
                <Button size="sm" type="submit" variant="outline">
                  <Undo2 class="size-4" />
                  Unban
                </Button>
              </form>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <section class="panel rounded-md">
    <PanelHeader
      description={`Addresses that requested blocked paths in the last ${data.ipBans.windowMinutes} minutes and aren't banned yet. ${data.ipBans.threshold} requests in that window gets an address banned.`}
      icon={Radar}
      title="Being counted"
    />
    {#if data.counting.length === 0}
      <p class="text-text-muted px-5 py-4 text-sm">
        No blocked requests in the window.
      </p>
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
            {#each data.counting as address (address.ip)}
              <tr class="border-border/60 border-b last:border-0">
                <td class="text-text px-4 py-3 font-mono">{address.ip}</td>
                <td class="text-text-muted px-4 py-3 tabular-nums">
                  {address.hits} / {data.ipBans.threshold}
                </td>
                <td class="text-text-muted hidden px-4 py-3 font-mono text-xs break-all md:table-cell">
                  {address.host ?? ""}{address.path ?? ""}
                  {#if address.userAgent}
                    <span class="text-text-subtle block">{address.userAgent}</span>
                  {/if}
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
