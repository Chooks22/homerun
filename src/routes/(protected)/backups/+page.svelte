<script lang="ts">
	import {
		ChevronRight,
		CloudUpload,
		Play,
		Settings,
		Trash2,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import BackupCancelButton from "#lib/components/backup-cancel-button.svelte";
	import DeployLogPanel from "#lib/components/deploy-log-panel.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityToolbar, {
		type FilterGroup,
	} from "#lib/components/entity-toolbar.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { formatDuration } from "#lib/resource-incidents.js";
	import { describeSchedule, scheduleFromCron } from "#lib/schedule.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Backups"));

	const backupEnabledVolumes = $derived(
		data.volumes.filter((v) => v.backupEnabled),
	);

	let runningVolumeId = $state<string | null>(null);
	let runningAll = $state(false);
	let pruning = $state(false);

	let expandedRunId = $state<string | null>(null);

	function toggleRun(id: string) {
		expandedRunId = expandedRunId === id ? null : id;
	}

	$effect(() => {
		if (!data.runs.some((run) => run.success === null)) {
			return;
		}
		const timer = setInterval(() => refreshAll(), 3000);
		return () => clearInterval(timer);
	});

	const filters: FilterGroup[] = [
		{
			key: "kind",
			label: "Kind",
			options: [
				{ label: "Backup", value: "backup" },
				{ label: "Restore", value: "restore" },
			],
		},
		{
			key: "outcome",
			label: "Outcome",
			options: [
				{ label: "Success", value: "success" },
				{ label: "Failed", value: "failed" },
				{ label: "Running", value: "running" },
			],
		},
	];

	function describeOrigin(origin: {
		services: string[];
		stacks: string[];
	}): string {
		if (origin.services.length === 0) {
			return "not mounted by any service";
		}
		const where =
			origin.stacks.length > 0 ? `${origin.stacks.join(", ")} · ` : "";
		return `${where}used by ${origin.services.join(", ")}`;
	}

	function formatDate(value: Date | string | null): string {
		if (!value) {
			return "—";
		}
		return new Date(value).toLocaleString();
	}

	function formatSize(bytes: number | null): string {
		if (bytes == null) {
			return "";
		}
		const units = ["B", "KB", "MB", "GB"];
		let value = bytes;
		let i = 0;
		while (value >= 1024 && i < units.length - 1) {
			value /= 1024;
			i += 1;
		}
		return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}
</script>

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Backups</h1>
      <p class="text-text-muted mt-1 text-sm">
        Per-volume S3 backups, restores and their run history. Configure a volume's
        destination and schedule from its own page.
      </p>
    </div>

    <Button
      href={resolve('s3-destinations')}
      variant="outline"
    >Manage destinations</Button>
  </div>

  <!-- ═══ Configured volumes ═══ -->
  <section class="mb-8">
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="eyebrow">Scheduled backups</h2>
      <div class="flex flex-wrap items-center gap-2">
      {#if backupEnabledVolumes.length > 0}
        <form
          action="?/prune"
          method="POST"
          use:enhance={enhanceToast({
            error: "Couldn't clean up the old backups.",
            loading: "Queueing the cleanup",
            onSettled: () => {
              pruning = false;
            },
            onStart: () => {
              pruning = true;
            },
            success: "Cleanup queued : follow it in the job queue.",
          })}
        >
          <Button
            disabled={pruning}
            size="sm"
            title="Delete each volume's archives past its destination's Backups to keep"
            type="submit"
            variant="outline"
          >
            {#if pruning}
              <Spinner />
            {:else}
              <Trash2 class="size-4" />
            {/if}
            Clean up old backups
          </Button>
        </form>
      {/if}
      {#if backupEnabledVolumes.length > 0}
        <form
          action="?/runAll"
          method="POST"
          use:enhance={enhanceToast({
            error: "Couldn't queue the backups.",
            loading: "Queueing every backup",
            onSettled: () => {
              runningAll = false;
            },
            onStart: () => {
              runningAll = true;
            },
            success: (data) =>
              `${data?.queued} ${data?.queued === 1 ? "backup" : "backups"} queued : they show up below once they start.`,
          })}
        >
          <Button disabled={runningAll} size="sm" type="submit" variant="outline">
            {#if runningAll}
              <Spinner />
            {:else}
              <Play class="size-4" />
            {/if}
            Run all
          </Button>
        </form>
      {/if}
      </div>
    </div>
    {#if backupEnabledVolumes.length === 0}
      <EmptyState
        icon={CloudUpload}
        subtitle="Flip the backup switch next to a volume on a service's Storage tab, or on the volume's own page under Storage."
        title="No volumes have backups enabled"
      >
        {#snippet children()}
          <Button href={resolve('storage')} variant="outline">Go to Storage</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="space-y-2.5">
        {#each backupEnabledVolumes as vol (vol.id)}
          <div class="panel flex flex-col gap-3 rounded-md p-4 sm:flex-row sm:items-center sm:gap-4">
            <div class="min-w-0 flex-1">
              <a
                class="text-text hover:text-accent truncate text-sm font-semibold"
                href="{resolve('storage')}/{vol.id}"
              >{vol.name}</a>

              <p class="text-text-muted mt-0.5 truncate text-xs">{describeOrigin(vol.origin)}</p>
              <p class="text-text-muted mt-0.5 truncate text-xs">{describeSchedule(scheduleFromCron(vol.backupSchedule))} · to {vol.destinationName} · {vol.destinationKeep ? `keeps the newest ${vol.destinationKeep}` : "keeps every backup"}</p>

              <p class="text-text-subtle mt-0.5 text-xs">
                next run {vol.nextRunAt ? formatDate(vol.nextRunAt) : "never"}
                · last run {formatDate(vol.backupLastRunAt)}
              </p>
            </div>
            <div class="flex items-center gap-2">
            <Button href="{resolve('storage')}/{vol.id}" variant="outline">
              <Settings class="size-4" />
              Settings
            </Button>
            <form
              action="?/run"
              method="POST"
              use:enhance={enhanceToast({
                error: "Couldn't queue the backup.",
                loading: "Queueing the backup",
                success: "Backup queued : it shows up below once it starts.",
              })}
            >
              <input name="volumeId" type="hidden" value={vol.id} />

              <Button
                disabled={runningVolumeId === vol.id}
                type="submit"
                variant="outline"
              >
                {#if runningVolumeId === vol.id}
                  <Spinner />
                {:else}
                  <Play class="size-4" />
                {/if}
                Run now
              </Button>
            </form>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ═══ Run log ═══ -->
  <section>
    <h2 class="eyebrow mb-3">Run log</h2>
    {#if data.total === 0 && !data.filtered}
      <EmptyState
        icon={CloudUpload}
        subtitle="Runs (scheduled or manual) will show up here."
        title="No backup runs yet"
      />
    {:else}
      <EntityToolbar
        filters={filters}
        placeholder="Search runs by volume, key or error…"
      />

      {#if data.runs.length === 0}
        <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
          <p class="text-text-muted text-sm">No runs match your filters.</p>
        </div>
      {:else}
        <div class="panel overflow-x-auto rounded-md">
          <table class="w-full text-sm">
            <thead>
            <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
                <th class="px-4 py-3 font-medium">Volume</th>
                <th class="px-4 py-3 font-medium">Kind</th>
                <th class="px-4 py-3 font-medium">Started</th>
                <th class="px-4 py-3 font-medium">Duration</th>
                <th class="px-4 py-3 font-medium">Size</th>
                <th class="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each data.runs as run (run.id)}
                {@const durationMs = run.finishedAt
                  ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
                  : null}
                <tr
                  class="border-border/60 hover:bg-surface-2 cursor-pointer border-b last:border-0"
                  onclick={() => toggleRun(run.id)}
                >
                <td class="text-text px-4 py-3 font-medium whitespace-nowrap">
                    <button
                      class="flex items-center gap-1.5 text-left"
                      aria-expanded={expandedRunId === run.id}
                      onclick={(event) => {
                        event.stopPropagation();
                        toggleRun(run.id);
                      }}
                      type="button"
                    >
                      <ChevronRight
                      class="text-text-subtle size-3.5 shrink-0 transition-transform {expandedRunId ===
                      run.id
                        ? 'rotate-90'
                        : ''}"
                      />
                      <span class="flex flex-col">
                        <span>{run.volumeName}</span>
                        <span class="text-text-subtle text-xs font-normal">{describeOrigin(run.origin)}</span>
                      </span>
                    </button>
                  </td>
                <td class="text-text-muted px-4 py-3" title={run.key ?? ""}>
                  {run.kind === "restore" ? "Restore" : "Backup"}
                </td>
                <td class="text-text-muted px-4 py-3 whitespace-nowrap">{formatDate(run.startedAt)}</td>
                <td class="text-text-muted px-4 py-3">
                  {durationMs != null ? formatDuration(durationMs) : "—"}
                </td>
                  <td class="text-text-muted px-4 py-3">{formatSize(run.sizeBytes)}</td>
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-2">
                      <RunStatusBadge error={run.error} success={run.success}>
                        {#snippet running()}
                        <span class="text-text-muted flex items-center gap-1 text-xs">
                          <Spinner class="size-3" />
                          Running
                        </span>
                        {/snippet}
                      </RunStatusBadge>
                      {#if run.success === null}
                        <BackupCancelButton kind={run.kind} runId={run.id} />
                      {/if}
                    </div>
                  </td>
                </tr>
                {#if expandedRunId === run.id}
                  <tr class="border-border/60 border-b last:border-0">
                    <td class="pt-3" colspan="6">
                      {#if run.log || run.error}
                        <DeployLogPanel
                          errorMessage={run.error}
                          log={run.log}
                          logName="{run.kind} log"
                        />
                      {:else}
                        <p class="text-text-muted px-5 pb-3 text-xs">
                          {run.success === null
                            ? "Waiting for the first line…"
                            : "This run has no log: it ran before runs kept one."}
                        </p>
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          label="runs"
          page={data.page}
          perPage={data.perPage}
          total={data.total}
        />
      {/if}
    {/if}
  </section>
</div>
