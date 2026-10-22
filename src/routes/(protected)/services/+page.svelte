<script lang="ts">
	import { FileUp, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";
	import ServicesList from "./services-list.svelte";

	const { data } = $props();

	onMount(() => title.set("Services"));
</script>

<div class="p-5 md:p-6">
  <div class="border-border mb-5 flex flex-wrap items-end justify-between gap-3 border-b pb-4">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Services</h1>
      <p class="text-text-muted mt-0.5 text-xs">
        Containers deployed to this server.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Button
        href={resolve('services/import')}
        size="sm"
        variant="outline"
      ><FileUp class="size-4" />Import compose</Button>

      <Button href={resolve('services/new')} size="sm"><Plus class="size-4" />Deploy a Service</Button>
    </div>
  </div>

  {#await data.listing}
    <div aria-busy="true" class="space-y-3">
      <Skeleton class="h-9 w-full" />
      {#each { length: data.treeView ? 4 : 6 }, i (i)}
        <Skeleton class="h-14 w-full" />
      {/each}
    </div>
  {:then listing}
    <ServicesList
      filtered={data.filtered}
      listing={listing}
      page={data.page}
      perPage={data.perPage}
      serviceDomain={data.serviceDomain}
    />
  {:catch}
    <div class="border-border/70 text-text-muted rounded-md border border-dashed py-16 text-center text-sm">
      Couldn't load the services.
    </div>
  {/await}
</div>
