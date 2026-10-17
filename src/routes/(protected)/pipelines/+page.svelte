<script lang="ts">
	import { Plus, RefreshCw, Workflow } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PipelineRepositoryTable from "#lib/components/pipelines/pipeline-repository-table.svelte";
	import PipelineRunList from "#lib/components/pipelines/pipeline-run-list.svelte";
	import PipelineStats from "#lib/components/pipelines/pipeline-stats.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { queuedJobToast } from "#lib/job-toast.js";
	import { title } from "#lib/store/title.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();
	const overview = $derived(data.overview);
	const anyEnabled = $derived(
		overview.repositories.some((row) => row.repository.pipelinesEnabled),
	);

	onMount(() => title.set("Pipelines"));

	let syncing = $state(false);
</script>

<div class="p-5 md:p-6">
  <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1 basis-80">
      <h1 class="text-text text-lg font-semibold tracking-tight">Pipelines</h1>
      <p class="text-text-muted mt-1 text-sm">
        GitHub Actions, GitLab CI and Gitea Actions runs of the repositories you watch, with what they
        cost. Link a repository to a service to see its runs there and its errors' source.
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if anyEnabled}
        <form
          action="?/syncAll"
          method="POST"
          use:enhance={queuedJobToast({
            error: "Couldn't queue the syncs.",
            loading: "Queueing a sync of every repository",
            onSettled: () => {
              syncing = false;
            },
            onStart: () => {
              syncing = true;
            },
            success: (result) =>
              `Queued ${result?.queued ?? 0} ${result?.queued === 1 ? "sync" : "syncs"}.`,
          })}
        >
          <Button disabled={syncing} size="sm" type="submit" variant="outline">
            {#if syncing}
              <Spinner />
            {:else}
              <RefreshCw class="size-4" />
            {/if}
            Sync all now
          </Button>
        </form>
      {/if}
      <Button href={resolve("pipelines/new")} size="sm">
        <Plus class="size-4" />
        Watch repositories
      </Button>
    </div>
  </div>

  {#if overview.repositories.length === 0}
    <EmptyState
      icon={Workflow}
      subtitle="Pick a repository from a connected git provider to start reading its CI runs."
      title="No repository watched yet"
    >
      <Button href={resolve("pipelines/new")} size="sm">
        <Plus class="size-4" />
        Watch repositories
      </Button>
    </EmptyState>
  {:else}
    <div class="space-y-6">
      <PipelineStats
        allTime={overview.allTime}
        window={overview.window}
        windowDays={data.windowDays}
        workflows={[]}
      />
      <PipelineRepositoryTable repositories={overview.repositories} windowDays={data.windowDays} />
      <PipelineRunList
        emptySubtitle="Runs show up here after the first sync."
        listing={data.listing}
        searched={data.searched}
        showRepository
      />
    </div>
  {/if}
</div>
