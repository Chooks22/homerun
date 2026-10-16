<script lang="ts">
	import { BarChart3 } from "@lucide/svelte";
	import type { PipelineStats } from "#lib/dto/pipeline-run-dto.js";
	import { formatCount, formatPercent } from "#lib/metrics-format.js";
	import {
		formatCompactDuration,
		formatRunDuration,
		formatUsd,
	} from "#lib/pipelines/list.js";

	interface Props {
		allTime: PipelineStats;
		window: PipelineStats;
		windowDays: number;
		workflows: PipelineStats[];
	}

	const { allTime, window, windowDays, workflows }: Props = $props();

	const tiles = $derived([
		{ label: "Runs", value: formatCount(window.runs) },
		{
			label: "Success rate",
			value: formatPercent(window.succeeded, window.succeeded + window.failed),
		},
		{ label: "Duration p50", value: formatCompactDuration(window.p50Ms) },
		{ label: "Duration p95", value: formatCompactDuration(window.p95Ms) },
		{ label: "Avg queue", value: formatCompactDuration(window.avgQueueMs) },
		{ label: "Billable minutes", value: formatCount(window.billableMinutes) },
		{ label: "Cost", value: formatUsd(window.costUsd) },
		{ label: "Cost, all time", value: formatUsd(allTime.costUsd) },
	]);
</script>

<section class="panel rounded-md">
  <div class="panel-head">
    <h2 class="eyebrow flex items-center gap-1.5">
      <BarChart3 class="size-3" />
      Last {windowDays} days
    </h2>
  </div>
  <div class="divide-border grid grid-cols-2 divide-x border-b sm:grid-cols-4 xl:grid-cols-8">
    {#each tiles as tile (tile.label)}
      <div class="border-border min-w-0 px-4 py-3">
        <p class="text-text-muted text-xs">{tile.label}</p>
        <p class="metric mt-1 truncate">{tile.value}</p>
      </div>
    {/each}
  </div>
  {#if workflows.length > 0}
    <div class="relative overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
            <th class="px-4 py-3 font-medium">Workflow</th>
            <th class="px-4 py-3 text-right font-medium">Runs</th>
            <th class="px-4 py-3 text-right font-medium">Success</th>
            <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">p50</th>
            <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">p95</th>
            <th class="hidden px-4 py-3 text-right font-medium md:table-cell">Minutes</th>
            <th class="px-4 py-3 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each workflows as workflow (workflow.name)}
            <tr class="border-border/60 border-b last:border-0">
              <td class="text-text max-w-0 truncate px-4 py-3 font-medium">{workflow.name}</td>
              <td class="text-text-muted px-4 py-3 text-right">{formatCount(workflow.runs)}</td>
              <td class="text-text-muted px-4 py-3 text-right">
                {formatPercent(workflow.succeeded, workflow.succeeded + workflow.failed)}
              </td>
              <td class="text-text-muted hidden px-4 py-3 text-right font-mono text-xs sm:table-cell">
                {formatRunDuration(workflow.p50Ms)}
              </td>
              <td class="text-text-muted hidden px-4 py-3 text-right font-mono text-xs sm:table-cell">
                {formatRunDuration(workflow.p95Ms)}
              </td>
              <td class="text-text-muted hidden px-4 py-3 text-right md:table-cell">
                {formatCount(workflow.billableMinutes)}
              </td>
              <td class="text-text px-4 py-3 text-right font-mono text-xs">{formatUsd(workflow.costUsd)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
