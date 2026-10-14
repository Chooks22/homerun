<script lang="ts">
	import { ScrollText } from "@lucide/svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { timeAgo } from "#lib/formatting.js";
	import type { AuditLog } from "#lib/server/db/schema.js";

	interface Props {
		entries: AuditLog[];
		showActor?: boolean;
	}

	const { entries, showActor = false }: Props = $props();

	const ACTION_LABELS: Record<string, string> = {
		"api.request": "API request",
		"gate.handshake": "Login wall",
	};

	function statusClass(status: number | null): string {
		if (status === null) {
			return "text-text-muted";
		}
		return status >= 400
			? "text-red-600 dark:text-red-400"
			: "text-emerald-600 dark:text-emerald-400";
	}
</script>

{#if entries.length === 0}
  <EmptyState
    icon={ScrollText}
    subtitle="Every use of a service account's key, through a login wall or the API, shows up here."
    title="No activity yet"
  />
{:else}
  <div class="border-border overflow-x-auto rounded-md border">
    <table class="w-full text-sm">
      <thead class="bg-surface-2 text-text-muted text-left text-xs">
        <tr>
          <th class="px-4 py-2 font-medium">When</th>
          {#if showActor}
            <th class="px-4 py-2 font-medium">Account</th>
          {/if}
          <th class="px-4 py-2 font-medium">What</th>
          <th class="px-4 py-2 font-medium">Detail</th>
          <th class="px-4 py-2 font-medium">Status</th>
          <th class="px-4 py-2 font-medium">From</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.id)}
          <tr class="border-border border-t">
            <td class="text-text-muted px-4 py-2 whitespace-nowrap" title={new Date(entry.createdAt).toLocaleString()}>
              {timeAgo(entry.createdAt)}
            </td>
            {#if showActor}
              <td class="text-text px-4 py-2 whitespace-nowrap">
                {entry.actorName}
                {#if entry.actorId === null}
                  <span class="text-text-subtle text-xs">(deleted)</span>
                {/if}
              </td>
            {/if}
            <td class="text-text px-4 py-2 whitespace-nowrap">
              {ACTION_LABELS[entry.action] ?? entry.action}
            </td>
            <td class="text-text-muted px-4 py-2 font-mono text-xs break-all">{entry.detail}</td>
            <td class="px-4 py-2 font-mono text-xs {statusClass(entry.status)}">{entry.status ?? "–"}</td>
            <td class="text-text-muted px-4 py-2 font-mono text-xs whitespace-nowrap">{entry.ipAddress ?? "–"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
