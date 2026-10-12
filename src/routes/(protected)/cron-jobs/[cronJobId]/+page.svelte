<script lang="ts">
	import { ChevronDown, History } from "@lucide/svelte";
	import { onMount } from "svelte";
	import AnsiLine from "#lib/components/ansi-line.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { getCronJobRuns } from "#lib/remote/cron-runs.remote.js";

	const { data } = $props();

	const RUN_POLL_MS = 2000;

	const liveRuns = $derived(getCronJobRuns(data.job.id));
	const runs = $derived(liveRuns.current ?? data.runs);
	const running = $derived(runs.some((run) => run.finishedAt === null));

	onMount(() => {
		const timer = setInterval(() => {
			if (running) {
				void liveRuns.refresh();
			}
		}, RUN_POLL_MS);
		return () => clearInterval(timer);
	});

	let expandedRunId = $state<string | null>(null);
</script>

{#if runs.length === 0}
  <EmptyState
    icon={History}
    subtitle="Runs show up here with their output, once the schedule fires or you press Run now."
    title="No runs yet"
  />
{:else}
  <section class="panel rounded-md">
    <PanelHeader title="Run history" />
    <div class="divide-border divide-y">
      {#each runs as run (run.id)}
        <div>
          <button
            class="flex w-full items-center gap-3 px-5 py-3 text-left text-sm"
            onclick={() => {
              expandedRunId = expandedRunId === run.id ? null : run.id;
            }}
            type="button"
          >
            <RunStatusBadge iconOnly success={run.success}>
              {#snippet running()}
                <Spinner class="size-3.5 shrink-0" />
              {/snippet}
            </RunStatusBadge>
            <span class="text-text-muted min-w-0 flex-1 truncate text-xs">
              {new Date(run.startedAt).toLocaleString()}
              {#if run.exitCode !== null}
                · exit {run.exitCode}
              {/if}
              {#if run.error}
                · <span class="text-red-500">{run.error}</span>
              {/if}
            </span>
            {#if run.output}
              <ChevronDown
                class="text-text-muted size-4 shrink-0 transition-transform {expandedRunId ===
                run.id
                  ? 'rotate-180'
                  : ''}"
              />
            {/if}
          </button>
          {#if expandedRunId === run.id && run.output}
            <div class="mx-5 mb-3 max-h-96 overflow-y-auto rounded-md log-output">
              {#each run.output.split("\n").filter(Boolean) as line, i (i)}
                <AnsiLine {line} />
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}
