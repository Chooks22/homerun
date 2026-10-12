<script lang="ts">
	import { Trash2 } from "@lucide/svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { formatDate } from "#lib/formatting.js";
	import type { CrowdsecDecision } from "#lib/services/crowdsec.service.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const {
		canWrite,
		decisions,
	}: { canWrite: boolean; decisions: CrowdsecDecision[] } = $props();
</script>

<div class="overflow-x-auto">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
        <th class="px-4 py-3 font-medium">Value</th>
        <th class="px-4 py-3 font-medium">Reason</th>
        <th class="hidden px-4 py-3 font-medium md:table-cell">Origin</th>
        <th class="px-4 py-3 font-medium">Until</th>
        {#if canWrite}
          <th class="px-4 py-3"></th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each decisions as decision (decision.id)}
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
          {#if canWrite}
            <td class="px-4 py-3 text-right">
              <form
                action="{resolve('/(protected)/monitoring/crowdsec')}?/deleteDecision"
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
