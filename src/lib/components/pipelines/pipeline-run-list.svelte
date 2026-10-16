<script lang="ts">
	import { Activity, ExternalLink, Workflow } from "@lucide/svelte";
	import Alert from "#lib/components/alert.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityToolbar, {
		type FilterGroup,
	} from "#lib/components/entity-toolbar.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import type { PipelineRunRow } from "#lib/dto/pipeline-run-dto.js";
	import { timeAgo } from "#lib/formatting.js";
	import {
		formatRunDuration,
		formatUsd,
		PIPELINE_SORTS,
		PIPELINE_STATUS_LABELS,
	} from "#lib/pipelines/list.js";
	import { PIPELINE_STATUSES } from "#lib/pipelines/types.js";
	import { resolve } from "$app/paths";
	import PipelineStatusBadge from "./pipeline-status-badge.svelte";

	interface RunListing {
		items: PipelineRunRow[];
		page: number;
		perPage: number;
		total: number;
	}

	interface Props {
		emptySubtitle: string;
		listing: Promise<RunListing>;
		searched: boolean;
		showRepository?: boolean;
	}

	const {
		emptySubtitle,
		listing,
		searched,
		showRepository = false,
	}: Props = $props();

	function runDetails(run: PipelineRunRow): string {
		return [run.title, run.branch, run.commitSha?.slice(0, 7), run.event]
			.filter(Boolean)
			.join(" · ");
	}

	function traceHref(run: PipelineRunRow): string {
		const traceId = run.traceId ?? "";
		return run.traceServiceId
			? resolve(
					"/(protected)/services/[serviceId]/observability/traces/[traceId]",
					{ serviceId: run.traceServiceId, traceId },
				)
			: resolve("/(protected)/monitoring/traces/[traceId]", { traceId });
	}

	const filters: FilterGroup[] = [
		{
			key: "status",
			label: "Status",
			options: PIPELINE_STATUSES.map((status) => ({
				label: PIPELINE_STATUS_LABELS[status],
				value: status,
			})),
		},
	];

	function reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
</script>

<div class="space-y-3">
  <EntityToolbar
    filters={filters}
    placeholder={showRepository
      ? "Search repositories, workflows, branches, commits…"
      : "Search workflows, branches, commits…"}
    sorts={PIPELINE_SORTS}
  />

  {#await listing}
    <div class="space-y-2">
      {#each { length: 6 }, i (i)}
        <Skeleton class="h-12 w-full" />
      {/each}
    </div>
  {:then result}
    {#if result.total === 0 && !searched}
      <EmptyState icon={Workflow} subtitle={emptySubtitle} title="No CI runs yet" />
    {:else if result.items.length === 0}
      <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
        <p class="text-text-muted text-sm">No run matches your filters.</p>
      </div>
    {:else}
      <div class="panel relative overflow-x-auto rounded-md">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
              <th class="w-2/5 min-w-48 px-4 py-3 font-medium">Run</th>
              <th class="px-4 py-3 font-medium">Status</th>
              <th class="px-4 py-3 text-right font-medium">Duration</th>
              <th class="hidden px-4 py-3 text-right font-medium md:table-cell">Queued</th>
              <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">Jobs</th>
              <th class="px-4 py-3 text-right font-medium">Cost</th>
              <th class="hidden px-4 py-3 font-medium lg:table-cell">Started</th>
              <th class="px-4 py-3"><span class="sr-only">Links</span></th>
            </tr>
          </thead>
          <tbody>
            {#each result.items as run (run.id)}
              <tr class="border-border/60 hover:bg-surface-2 border-b last:border-0">
                <td class="max-w-0 min-w-48 px-4 py-3">
                  <span class="text-text block truncate font-medium">
                    {#if showRepository}
                      <a
                        class="hover:text-accent"
                        href={resolve("/(protected)/pipelines/[repositoryId]", {
                          repositoryId: run.repositoryId,
                        })}
                      >{run.repositoryName}</a>
                      <span class="text-text-subtle">·</span>
                    {/if}
                    {run.name}
                    {#if run.number !== null}
                      <span class="text-text-subtle">#{run.number}</span>
                    {/if}
                  </span>
                  <span class="text-text-subtle block truncate text-xs">{runDetails(run)}</span>
                </td>
                <td class="px-4 py-3"><PipelineStatusBadge status={run.status} /></td>
                <td class="text-text px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {formatRunDuration(run.durationMs)}
                </td>
                <td class="text-text-muted hidden px-4 py-3 text-right font-mono text-xs whitespace-nowrap md:table-cell">
                  {formatRunDuration(run.queueMs)}
                </td>
                <td class="text-text-muted hidden px-4 py-3 text-right sm:table-cell">{run.jobs.filter((job) => job.attempt === run.attempt).length}</td>
                <td
                  class="text-text px-4 py-3 text-right font-mono text-xs whitespace-nowrap"
                  title="{run.billableMinutes} billable minutes"
                >
                  {formatUsd(run.costUsd)}
                </td>
                <td
                  class="text-text-muted hidden px-4 py-3 whitespace-nowrap lg:table-cell"
                  title={new Date(run.createdAt).toLocaleString()}
                >
                  {timeAgo(run.createdAt)}
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center justify-end gap-2">
                    {#if run.traceExported && run.traceId}
                      <a
                        class="text-text-subtle hover:text-accent"
                        aria-label="Open the trace"
                        href={traceHref(run)}
                        title="Open the trace"
                      >
                        <Activity class="size-4" />
                      </a>
                    {/if}
                    {#if run.url}
                      <a
                        class="text-text-subtle hover:text-accent"
                        aria-label="Open on the provider"
                        href={run.url}
                        rel="noopener noreferrer"
                        target="_blank"
                        title="Open on the provider"
                      >
                        <ExternalLink class="size-4" />
                      </a>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination label="runs" page={result.page} perPage={result.perPage} total={result.total} />
    {/if}
  {:catch error}
    <Alert title="Couldn't load the runs.">{reason(error)}</Alert>
  {/await}
</div>
