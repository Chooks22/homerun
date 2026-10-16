<script lang="ts">
	import { AlertTriangle, GitBranch } from "@lucide/svelte";
	import { timeAgo } from "#lib/formatting.js";
	import { GIT_PROVIDER_KIND_LABELS } from "#lib/git-provider-kinds.js";
	import { formatCount, formatPercent } from "#lib/metrics-format.js";
	import { formatRunDuration, formatUsd } from "#lib/pipelines/list.js";
	import type { RepositoryPipelines } from "#lib/services/pipeline.service.js";
	import { resolve } from "$app/paths";

	interface Props {
		repositories: RepositoryPipelines[];
		windowDays: number;
	}

	const { repositories, windowDays }: Props = $props();
</script>

<section class="panel rounded-md">
  <div class="panel-head">
    <h2 class="eyebrow flex items-center gap-1.5">
      <GitBranch class="size-3" />
      Repositories · last {windowDays} days
    </h2>
  </div>
  <div class="relative overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
          <th class="w-1/3 min-w-48 px-4 py-3 font-medium">Repository</th>
          <th class="hidden px-4 py-3 font-medium md:table-cell">Services</th>
          <th class="px-4 py-3 text-right font-medium">Runs</th>
          <th class="px-4 py-3 text-right font-medium">Success</th>
          <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">p50</th>
          <th class="px-4 py-3 text-right font-medium">Cost</th>
          <th class="hidden px-4 py-3 font-medium lg:table-cell">Last sync</th>
        </tr>
      </thead>
      <tbody>
        {#each repositories as row (row.repository.id)}
          <tr class="border-border/60 hover:bg-surface-2 border-b last:border-0">
            <td class="max-w-0 min-w-48 px-4 py-3">
              <a
                class="text-text hover:text-accent block truncate font-medium"
                href={resolve("/(protected)/pipelines/[repositoryId]", { repositoryId: row.repository.id })}
              >
                {row.repository.fullName}
              </a>
              {#if row.repository.pipelinesError}
                <span class="flex items-center gap-1 truncate text-xs text-red-500" title={row.repository.pipelinesError}>
                  <AlertTriangle class="size-3 shrink-0" />
                  {row.repository.pipelinesError}
                </span>
              {:else}
                <span class="text-text-subtle block truncate text-xs">
                  {GIT_PROVIDER_KIND_LABELS[row.repository.providerKind]}{row.repository.pipelinesEnabled ? "" : " · sync off"}
                </span>
              {/if}
            </td>
            <td class="text-text-muted hidden max-w-0 truncate px-4 py-3 md:table-cell">
              {row.services.map((linked) => linked.name).join(", ") || "—"}
            </td>
            <td class="text-text-muted px-4 py-3 text-right">{formatCount(row.stats?.runs ?? 0)}</td>
            <td class="text-text-muted px-4 py-3 text-right">
              {formatPercent(row.stats?.succeeded ?? 0, (row.stats?.succeeded ?? 0) + (row.stats?.failed ?? 0))}
            </td>
            <td class="text-text-muted hidden px-4 py-3 text-right font-mono text-xs sm:table-cell">
              {formatRunDuration(row.stats?.p50Ms ?? null)}
            </td>
            <td class="text-text px-4 py-3 text-right font-mono text-xs">{formatUsd(row.stats?.costUsd ?? 0)}</td>
            <td class="text-text-muted hidden px-4 py-3 whitespace-nowrap lg:table-cell">
              {row.repository.pipelinesSyncedAt ? timeAgo(row.repository.pipelinesSyncedAt) : "—"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
