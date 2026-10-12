<script lang="ts">
	import { ChevronRight, History, ScrollText } from "@lucide/svelte";
	import { onMount } from "svelte";
	import DeployLogPanel from "#lib/components/deploy-log-panel.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import {
		cronJobRunTriggerLabel,
		latestCronJobRun,
	} from "#lib/cron-job-script.js";
	import { getCronJobRuns } from "#lib/remote/cron-runs.remote.js";
	import { formatDuration } from "#lib/resource-incidents.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	const RUN_POLL_MS = 2000;

	const live = $derived(getCronJobRuns(data.job.id));
	const activity = $derived(
		live.current ?? { active: data.active, runs: data.runs },
	);
	const latest = $derived(
		latestCronJobRun(activity.runs, activity.active?.id ?? null),
	);
	const polling = $derived(
		latest.waiting || activity.runs.some((run) => run.finishedAt === null),
	);

	onMount(() => {
		const timer = setInterval(() => {
			if (polling) {
				void live.refresh();
			}
		}, RUN_POLL_MS);
		return () => clearInterval(timer);
	});

	function runHref(runId: string): string {
		return resolve("/(protected)/cron-jobs/[cronJobId]/runs/[runId]", {
			cronJobId: data.job.id,
			runId,
		});
	}

	function took(run: { finishedAt: Date | null; startedAt: Date }): string {
		return run.finishedAt
			? formatDuration(
					new Date(run.finishedAt).getTime() -
						new Date(run.startedAt).getTime(),
				)
			: "";
	}
</script>

{#if latest.run || latest.waiting}
  <section class="panel mb-6 rounded-md">
    <PanelHeader
      description={latest.run
        ? `${new Date(latest.run.startedAt).toLocaleString()} · ${cronJobRunTriggerLabel(latest.run.trigger)}`
        : "Queued, waiting for the worker"}
      icon={ScrollText}
      title="Latest run"
    >
      {#snippet trailing()}
        {#if latest.run}
          <RunStatusBadge error={latest.run.error} success={latest.run.success}>
            {#snippet running()}
              <span class="text-text-muted flex items-center gap-1 text-xs">
                <Spinner class="size-3.5" />
                Running
              </span>
            {/snippet}
          </RunStatusBadge>
          {#if latest.run.exitCode !== null}
            <span class="text-text-muted text-xs">exit {latest.run.exitCode}</span>
          {/if}
          <a class="text-accent text-xs hover:underline" href={runHref(latest.run.id)}>Open run</a>
        {:else}
          <span class="text-text-muted flex items-center gap-1 text-xs">
            <Spinner class="size-3.5" />
            {activity.active?.status === "running" ? "Starting" : "Queued"}
          </span>
        {/if}
      {/snippet}
    </PanelHeader>
    {#if latest.run && (latest.run.output || latest.run.error)}
      <div class="pt-3">
        <DeployLogPanel
          errorMessage={latest.run.error}
          log={latest.run.output ?? ""}
          logName="run output"
        />
      </div>
    {:else}
      <p class="text-text-muted px-5 py-4 text-sm">
        {#if latest.waiting}
          The output shows up here as soon as the worker starts the run.
        {:else if latest.run?.finishedAt}
          This run didn't print anything.
        {:else}
          The output shows up here as the run prints it.
        {/if}
      </p>
    {/if}
  </section>
{/if}

{#if activity.runs.length === 0}
  {#if !latest.waiting}
    <EmptyState
      icon={History}
      subtitle="Runs show up here with their output, once the schedule fires or you press Run now."
      title="No runs yet"
    />
  {/if}
{:else}
  <section class="panel rounded-md">
    <PanelHeader title="Run history" />
    <div class="divide-border divide-y">
      {#each activity.runs as run (run.id)}
        <a
          class="hover:bg-surface-2 flex items-center gap-3 px-5 py-3 text-sm transition-colors"
          href={runHref(run.id)}
        >
          <RunStatusBadge iconOnly success={run.success}>
            {#snippet running()}
              <Spinner class="size-3.5 shrink-0" />
            {/snippet}
          </RunStatusBadge>
          <span class="text-text-muted min-w-0 flex-1 truncate text-xs">
            {new Date(run.startedAt).toLocaleString()}
            · {cronJobRunTriggerLabel(run.trigger)}
            {#if run.exitCode !== null}
              · exit {run.exitCode}
            {/if}
            {#if run.error}
              · <span class="text-red-500">{run.error}</span>
            {/if}
          </span>
          <span class="text-text-muted shrink-0 text-xs tabular-nums">{took(run)}</span>
          <ChevronRight class="text-text-muted size-4 shrink-0" />
        </a>
      {/each}
    </div>
  </section>
{/if}
