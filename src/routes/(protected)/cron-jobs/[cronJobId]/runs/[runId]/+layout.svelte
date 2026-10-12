<script lang="ts">
	import { Activity, ArrowLeft, ScrollText } from "@lucide/svelte";
	import { onMount } from "svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import SectionNav from "#lib/components/section-nav.svelte";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { cronJobRunTriggerLabel } from "#lib/cron-job-script.js";
	import { getCronJobRun } from "#lib/remote/cron-runs.remote.js";
	import { formatDuration } from "#lib/resource-incidents.js";
	import { resolve } from "$app/paths";

	const { children, data } = $props();

	const RUN_POLL_MS = 2000;

	const live = $derived(
		getCronJobRun({ cronJobId: data.job.id, runId: data.run.id }),
	);
	const run = $derived(live.current ?? data.run);

	onMount(() => {
		const timer = setInterval(() => {
			if (run.finishedAt === null) {
				void live.refresh();
			}
		}, RUN_POLL_MS);
		return () => clearInterval(timer);
	});

	const params = $derived({ cronJobId: data.job.id, runId: data.run.id });
	const sections = $derived([
		{
			href: resolve("/(protected)/cron-jobs/[cronJobId]/runs/[runId]", params),
			icon: ScrollText,
			label: "Logs",
		},
		{
			href: resolve(
				"/(protected)/cron-jobs/[cronJobId]/runs/[runId]/traces",
				params,
			),
			icon: Activity,
			label: "Traces",
		},
	]);

	function when(value: Date | null): string {
		return value ? new Date(value).toLocaleString() : "Not yet";
	}
</script>

<a
  class="text-text-muted hover:text-text mb-5 inline-flex items-center gap-1 text-sm"
  href={resolve("/(protected)/cron-jobs/[cronJobId]", { cronJobId: data.job.id })}
>
  <ArrowLeft class="size-4" />
  All runs
</a>

<section class="panel mb-5 rounded-md">
  <PanelHeader icon={ScrollText} title="Run of {data.job.name}">
    {#snippet trailing()}
      <RunStatusBadge error={run.error} success={run.success}>
        {#snippet running()}
          <span class="text-text-muted flex items-center gap-1 text-xs">
            <Spinner class="size-3.5" />
            Running
          </span>
        {/snippet}
      </RunStatusBadge>
    {/snippet}
  </PanelHeader>
  <dl class="grid gap-3 px-5 py-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
    <div>
      <dt class="text-text-muted text-xs">Trigger</dt>
      <dd class="text-text mt-0.5">{cronJobRunTriggerLabel(run.trigger)}</dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Started</dt>
      <dd class="text-text mt-0.5">{when(run.startedAt)}</dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Finished</dt>
      <dd class="text-text mt-0.5">{when(run.finishedAt)}</dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Took</dt>
      <dd class="text-text mt-0.5">
        {run.finishedAt
          ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
          : "Not yet"}
      </dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Exit code</dt>
      <dd class="text-text mt-0.5 font-mono tabular-nums">{run.exitCode ?? (run.finishedAt ? "None" : "Not yet")}</dd>
    </div>
  </dl>
  {#if run.error}
    <p class="border-border border-t px-5 py-3 text-sm text-red-500">{run.error}</p>
  {/if}
</section>

<SectionNav label="Run sections" {sections} />

<ErrorBoundary title="This section hit an error while rendering.">
  {@render children()}
</ErrorBoundary>
