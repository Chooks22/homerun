<script lang="ts">
	import { CircleCheck, CircleX } from "@lucide/svelte";

	interface SelfTestCheck {
		detail: string;
		label: string;
		ok: boolean;
	}

	const {
		checks,
		class: className = "",
	}: { checks: SelfTestCheck[]; class?: string } = $props();
</script>

<ul class="space-y-2 {className}">
  {#each checks as check (check.label)}
    <li class="flex items-start gap-2 text-sm">
      {#if check.ok}
        <CircleCheck class="mt-0.5 size-4 shrink-0 text-green-500" />
      {:else}
        <CircleX class="mt-0.5 size-4 shrink-0 text-red-500" />
      {/if}
      <span>
        <span class="text-text font-medium">{check.label}</span>
        <span class="text-text-muted block text-xs">{check.detail}</span>
      </span>
    </li>
  {/each}
</ul>
