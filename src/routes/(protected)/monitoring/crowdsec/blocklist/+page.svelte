<script lang="ts">
	import { Users } from "@lucide/svelte";
	import EntityToolbar from "#lib/components/entity-toolbar.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import DecisionsTable from "../decisions-table.svelte";

	const { data } = $props();
</script>

<div class="space-y-4">
  <EntityToolbar placeholder="Search an address or scenario…" />
  <section class="panel rounded-md">
    <PanelHeader
      description="Addresses the CrowdSec community reported, which this server's bouncers block too. Refreshed by CrowdSec every couple of hours; read here at most once a minute."
      icon={Users}
      title="Community blocklist"
    />
    {#await data.blocklist}
      <div class="space-y-2 p-5">
        <Skeleton class="h-6 w-full" />
        <Skeleton class="h-6 w-2/3" />
      </div>
    {:then blocklist}
      {#if blocklist?.error}
        <p class="text-text-muted px-5 py-4 text-sm">{blocklist.error}</p>
      {:else if !blocklist?.total}
        <p class="text-text-muted px-5 py-4 text-sm">
          {data.searched ? "Nothing in the blocklist matches." : "The community blocklist is empty."}
        </p>
      {:else}
        <DecisionsTable canWrite={data.canWrite} decisions={blocklist.items} />
        <div class="px-5 pb-5">
          <Pagination
            label="addresses"
            page={data.page}
            perPage={data.perPage}
            total={blocklist.total}
          />
        </div>
      {/if}
    {/await}
  </section>
</div>
