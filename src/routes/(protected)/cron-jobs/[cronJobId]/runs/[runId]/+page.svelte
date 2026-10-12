<script lang="ts">
	import { ScrollText } from "@lucide/svelte";
	import DeployLogPanel from "#lib/components/deploy-log-panel.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { getCronJobRun } from "#lib/remote/cron-runs.remote.js";

	const { data } = $props();

	const live = $derived(
		getCronJobRun({ cronJobId: data.job.id, runId: data.run.id }),
	);
	const run = $derived(live.current ?? data.run);
</script>

{#if run.output || run.error}
  <section class="panel flex max-h-[75vh] flex-col rounded-md pt-3">
    <DeployLogPanel
      errorMessage={run.error}
      fill
      log={run.output ?? ""}
      logName="run output"
    />
  </section>
{:else}
  <EmptyState
    icon={ScrollText}
    subtitle={run.finishedAt
      ? "This run didn't print anything."
      : "The output shows up here as the run prints it."}
    title="No output yet"
  />
{/if}
