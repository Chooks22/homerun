<script lang="ts">
	import {
		Activity,
		CircleCheck,
		CircleX,
		Globe,
		MinusCircle,
		Plus,
		Send,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityList from "#lib/components/entity-list.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { title } from "#lib/store/title.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Status Page"));

	const view = new ViewMode("status-pages", "card");

	const SCOPE_LABEL = {
		custom: "Selected services",
		global: "Every service",
		stack: "One stack",
	};

	const down = $derived(data.services.filter((svc) => svc.health === "down"));
	const up = $derived(data.services.filter((svc) => svc.health === "up"));
	const unknown = $derived(
		data.services.filter((svc) => svc.health === "unknown"),
	);

	function pageById(id: string) {
		return data.pages.find((page) => page.id === id);
	}
</script>

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-wrap items-center justify-between gap-4">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Status Page</h1>
      <p class="text-text-muted mt-1 text-sm">
        Publish what's up, and get told when it isn't.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        href={resolve('notifications/settings/channels')}
        size="sm"
        variant="outline"
      ><Send class="size-4" />Notification channels</Button>

      <Button href={resolve('status-pages/new')} size="sm"><Plus class="size-4" />New status page</Button>
    </div>
  </div>

  <div class="mb-6 grid grid-cols-3 gap-4">
    <div class="panel rounded-md p-4">
      <p class="eyebrow flex items-center gap-1.5">
        <CircleCheck class="size-3 text-emerald-500" />
        Up
      </p>
      <p class="metric mt-1">{up.length}</p>
    </div>
    <div class="panel rounded-md p-4">
      <p class="eyebrow flex items-center gap-1.5">
        <CircleX class="size-3 text-red-500" />
        Down
      </p>
      <p class="metric mt-1">{down.length}</p>
    </div>
    <div class="panel rounded-md p-4">
      <p class="eyebrow flex items-center gap-1.5">
        <MinusCircle class="text-text-subtle size-3" />
        Not probed
      </p>
      <p class="metric mt-1">{unknown.length}</p>
    </div>
  </div>

  <section class="panel mb-6 rounded-md">
    <div class="panel-head">
      <h2 class="eyebrow flex items-center gap-1.5">
        <Activity class="size-3" />
        Every service
      </h2>
      <span class="text-text-subtle text-[0.6875rem]">
        Newest internal probe
      </span>
    </div>
    {#if data.services.length === 0}
      <p class="text-text-muted px-5 py-6 text-center text-xs">
        No services yet.
      </p>
    {:else}
      <div class="divide-border divide-y">
        {#each data.services as svc (svc.id)}
          <a
            class="hover:bg-surface-2 flex items-center gap-3 px-5 py-2.5 transition-colors"
            href="{resolve('services')}/{svc.id}"
          >
            {#if svc.health === "up"}
              <CircleCheck class="size-4 shrink-0 text-emerald-500" />
            {:else if svc.health === "down"}
              <CircleX class="size-4 shrink-0 text-red-500" />
            {:else}
              <MinusCircle class="text-text-subtle size-4 shrink-0" />
            {/if}
            <span class="text-text flex-1 truncate text-sm">{svc.name}</span>
            <span class="text-text-subtle shrink-0 text-xs">
              {svc.health === "unknown" ? "not probed yet" : svc.health}
            </span>
          </a>
        {/each}
      </div>
    {/if}
  </section>

  <h2 class="text-text mb-3 text-sm font-semibold">Status pages</h2>
  {#if data.pages.length === 0}
    <EmptyState
      icon={Globe}
      subtitle="A status page groups services and gives them one public URL."
      title="No status pages yet"
    ><Button href={resolve('status-pages/new')}><Plus class="size-4" />New status page</Button></EmptyState>
  {:else}
    {#snippet media(_item: { id: string })}
      <span class="bg-accent/10 text-accent flex size-8 shrink-0 items-center justify-center rounded-lg">
        <Globe class="size-4" />
      </span>
    {/snippet}

    {#snippet badge(item: { id: string })}
      {@const page = pageById(item.id)}
      {#if page}
        {#if page.downCount > 0}
          <span class="shrink-0 rounded-md bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
            {page.downCount} down
          </span>
        {:else}
          <span class="shrink-0 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            All up
          </span>
        {/if}
      {/if}
    {/snippet}

    {#snippet meta(item: { id: string })}
      {@const page = pageById(item.id)}
      {#if page}
        <span class="text-text-subtle shrink-0 text-xs">
          {page.serviceCount} tracked · {page.isPublic ? "public" : "private"}
        </span>
      {/if}
    {/snippet}

    <EntityList
      badge={badge}
      items={data.pages.map((page) => ({
        description: page.description,
        href: `${resolve('status-pages')}/${page.id}`,
        id: page.id,
        subtitle: SCOPE_LABEL[page.scope],
        title: page.name,
      }))}
      media={media}
      meta={meta}
      view={view}
    />
  {/if}
</div>
