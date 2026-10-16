<script lang="ts">
	import { ArrowRight, Workflow } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PipelineRunList from "#lib/components/pipelines/pipeline-run-list.svelte";
	import PipelineStats from "#lib/components/pipelines/pipeline-stats.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();
	const svc = $derived(data.service);
	const linked = $derived(data.linked);

	onMount(() => title.set(`${svc.name} · Pipelines`));
</script>

{#if !linked}
  <EmptyState
    icon={Workflow}
    subtitle="Link a watched repository to this service, from Pipelines in the sidebar, to see its CI runs here and link its errors to the source. Image services can link one too."
    title="No repository linked"
  >
    <Button href={resolve("pipelines")} size="sm" variant="outline">
      Open Pipelines
      <ArrowRight class="size-4" />
    </Button>
  </EmptyState>
{:else}
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-text-muted text-sm">
        CI runs of
        <a
          class="text-text hover:text-accent font-medium"
          href={resolve("/(protected)/pipelines/[repositoryId]", {
            repositoryId: linked.repository.id,
          })}
        >
          {linked.repository.fullName}
        </a>
        {#if linked.repository.pipelinesSyncedAt}
          · synced {timeAgo(linked.repository.pipelinesSyncedAt)}
        {/if}
      </p>
      <Button
        href={resolve("/(protected)/pipelines/[repositoryId]/settings", {
          repositoryId: linked.repository.id,
        })}
        size="sm"
        variant="outline"
      >
        Repository settings
      </Button>
    </div>
    {#if linked.repository.pipelinesError}
      <Alert title="The last sync failed.">{linked.repository.pipelinesError}</Alert>
    {/if}
    <PipelineStats
      allTime={linked.overview.allTime}
      window={linked.overview.window}
      windowDays={linked.windowDays}
      workflows={linked.overview.workflows}
    />
    <PipelineRunList
      emptySubtitle="Runs show up here after the repository's first sync."
      listing={linked.listing}
      searched={linked.searched}
    />
  </div>
{/if}
