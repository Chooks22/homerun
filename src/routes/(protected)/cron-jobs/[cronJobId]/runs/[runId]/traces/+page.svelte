<script lang="ts">
	import { Activity } from "@lucide/svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import TraceWaterfall from "#lib/components/tracing/trace-waterfall.svelte";
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";

	const POLL_MS = 2000;
	const SETTLE_MS = 30_000;

	const { data } = $props();

	const awaitingTrace = $derived(
		data.traces.length === 0 &&
			data.run.jobId !== null &&
			(data.run.finishedAt === null ||
				Date.now() - new Date(data.run.finishedAt).getTime() < SETTLE_MS),
	);

	$effect(() => {
		if (!awaitingTrace) {
			return;
		}
		const timer = setInterval(() => void refreshAll(), POLL_MS);
		return () => clearInterval(timer);
	});
</script>

{#if data.traces.length > 0}
  <section class="panel rounded-md">
    {#each data.traces as trace, index (trace.traceId)}
      <div class="border-border space-y-2 px-5 py-4 not-first:border-t">
        <div class="flex items-center justify-between gap-3">
          <h3 class="eyebrow">
            {data.traces.length > 1 ? `Trace · attempt ${index + 1}` : "Trace"}
          </h3>
          <a
            class="text-accent text-xs hover:underline"
            href={resolve("/(protected)/monitoring/traces/[traceId]", { traceId: trace.traceId })}
          >
            Open trace
          </a>
        </div>
        <TraceWaterfall spans={trace.spans} />
      </div>
    {/each}
  </section>
{:else if data.run.jobId === null}
  <EmptyState
    icon={Activity}
    subtitle="This run is from before runs remembered their queue job, so its trace can't be found."
    title="No trace for this run"
  />
{:else if awaitingTrace}
  <EmptyState
    icon={Activity}
    subtitle="The worker writes the run's trace a few seconds after it finishes."
    title="Waiting for the trace"
  />
{:else}
  <EmptyState
    icon={Activity}
    subtitle="Traces are kept for the retention set under Monitoring → Settings, so an older run's trace may be gone."
    title="No trace for this run"
  />
{/if}
