<script lang="ts">
	import { Plus, ShieldCheck } from "@lucide/svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { resolve } from "$app/paths";
	import DecisionsTable from "./decisions-table.svelte";

	const { data } = $props();
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="What CrowdSec's bouncers enforce right now from its own scenarios, manual bans and Homerun's. Bans Homerun pushed are marked. The community blocklist has its own tab."
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
  {#await data.decisions}
    <div class="space-y-2 p-5">
      <Skeleton class="h-6 w-full" />
      <Skeleton class="h-6 w-2/3" />
    </div>
  {:then decisions}
    {#if decisions?.error}
      <p class="text-text-muted px-5 py-4 text-sm">{decisions.error}</p>
    {:else if !decisions?.total}
      <p class="text-text-muted px-5 py-4 text-sm">No decision in force.</p>
    {:else}
      <DecisionsTable canWrite={data.canWrite} decisions={decisions.items} />
      <div class="px-5 pb-5">
        <Pagination
          label="decisions"
          page={data.page}
          perPage={data.perPage}
          total={decisions.total}
        />
      </div>
      {#if decisions.truncated}
        <p class="text-text-subtle border-border border-t px-5 py-3 text-xs">
          Only the decisions of the newest alerts are counted: the LAPI holds more.
        </p>
      {/if}
    {/if}
  {/await}
</section>
