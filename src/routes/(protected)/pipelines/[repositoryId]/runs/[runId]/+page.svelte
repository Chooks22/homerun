<script lang="ts">
	import { Activity, ArrowLeft, ExternalLink } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import PipelineStatusBadge from "#lib/components/pipelines/pipeline-status-badge.svelte";
	import TraceWaterfall from "#lib/components/tracing/trace-waterfall.svelte";
	import { timeAgo } from "#lib/formatting.js";
	import { formatRunDuration, formatUsd } from "#lib/pipelines/list.js";
	import { isFinished } from "#lib/pipelines/types.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();
	const run = $derived(data.run);
	const jobs = $derived([...run.jobs].sort((a, b) => b.attempt - a.attempt));

	onMount(() =>
		title.set(`${data.runCrumb.name} · ${data.repository.fullName}`),
	);

	const facts = $derived([
		["Branch", run.branch ?? "—"],
		["Commit", run.commitSha?.slice(0, 7) ?? "—"],
		["Trigger", run.event ?? "—"],
		["By", run.actor ?? "—"],
		["Queued", timeAgo(run.createdAt)],
		["Duration", formatRunDuration(run.durationMs)],
		["Time queued", formatRunDuration(run.queueMs)],
		["Attempt", String(run.attempt)],
		["Billable minutes", String(run.billableMinutes)],
		["Cost", formatUsd(run.costUsd)],
	]);

	const traceNote = $derived(
		!isFinished(run.status)
			? "The trace shows up once the run finishes."
			: run.traceExported
				? "This run's spans aren't stored any more: traces are only kept for the trace retention set under Monitoring → Settings."
				: "The trace is exported on the next sync.",
	);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 space-y-1">
      <a
        class="text-text-muted hover:text-text inline-flex items-center gap-1 text-sm"
        href={resolve("/(protected)/pipelines/[repositoryId]", {
          repositoryId: data.repository.id,
        })}
      >
        <ArrowLeft class="size-3.5" />
        All runs
      </a>
      <h2 class="text-text flex flex-wrap items-center gap-2 text-base font-semibold">
        {data.runCrumb.name}
        <PipelineStatusBadge status={run.status} />
      </h2>
      {#if run.title}
        <p class="text-text-muted truncate text-sm">{run.title}</p>
      {/if}
    </div>
    {#if run.url}
      <a
        class="text-text-muted hover:text-accent inline-flex items-center gap-1 text-sm"
        href={run.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        Open on the provider
        <ExternalLink class="size-3.5" />
      </a>
    {/if}
  </div>

  <dl class="panel grid grid-cols-2 gap-4 rounded-md p-4 sm:grid-cols-3 lg:grid-cols-5">
    {#each facts as [name, value] (name)}
      <div class="min-w-0">
        <dt class="text-text-subtle text-xs">{name}</dt>
        <dd class="text-text truncate font-mono text-sm" title={value}>{value}</dd>
      </div>
    {/each}
  </dl>

  <section class="panel rounded-md">
    <PanelHeader
      description="Every job of every attempt, the latest attempt first. Each attempt's minutes count towards the cost."
      title="Jobs"
    />
    {#if jobs.length === 0}
      <p class="text-text-muted p-5 text-sm">No job reported yet.</p>
    {:else}
      <div class="relative overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
              <th class="w-2/5 min-w-48 px-4 py-3 font-medium">Job</th>
              <th class="px-4 py-3 font-medium">Status</th>
              <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">Attempt</th>
              <th class="px-4 py-3 text-right font-medium">Duration</th>
              <th class="hidden px-4 py-3 text-right font-medium md:table-cell">Minutes</th>
              <th class="px-4 py-3 text-right font-medium">Cost</th>
              <th class="px-4 py-3"><span class="sr-only">Link</span></th>
            </tr>
          </thead>
          <tbody>
            {#each jobs as job, index (index)}
              <tr class="border-border/60 border-b last:border-0 {job.attempt === run.attempt ? '' : 'opacity-60'}">
                <td class="max-w-0 min-w-48 px-4 py-3">
                  <span class="text-text block truncate font-medium">{job.name}</span>
                  <span class="text-text-subtle block truncate text-xs">
                    {[job.stage, job.runner, job.labels.join(", ")].filter(Boolean).join(" · ") || "—"}
                  </span>
                </td>
                <td class="px-4 py-3"><PipelineStatusBadge status={job.status} /></td>
                <td class="text-text-muted hidden px-4 py-3 text-right sm:table-cell">{job.attempt}</td>
                <td class="text-text px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {formatRunDuration(job.durationMs)}
                </td>
                <td class="text-text-muted hidden px-4 py-3 text-right md:table-cell">{job.billableMinutes}</td>
                <td class="text-text px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatUsd(job.costUsd)}</td>
                <td class="px-4 py-3 text-right">
                  {#if job.url}
                    <a
                      class="text-text-subtle hover:text-accent inline-flex"
                      aria-label="Open the job on the provider"
                      href={job.url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLink class="size-4" />
                    </a>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="space-y-3">
    <h3 class="text-text flex items-center gap-2 text-sm font-semibold">
      <Activity class="size-4" />
      Trace
    </h3>
    {#if data.spans.length}
      <TraceWaterfall spans={data.spans} />
    {:else}
      <EmptyState icon={Activity} subtitle={traceNote} title="No trace to show" />
    {/if}
  </section>
</div>
