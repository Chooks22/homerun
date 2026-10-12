<script lang="ts">
	import { ChevronDown, Play, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import AnsiLine from "#lib/components/ansi-line.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import CronJobFields from "#lib/components/cron-job-fields.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { describeCronJobTarget } from "#lib/cron-job-script.js";
	import { timeAgo } from "#lib/formatting.js";
	import { getCronJobRuns } from "#lib/remote/cron-runs.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	const job = $derived(data.job);

	const RUN_POLL_MS = 2000;

	const liveRuns = $derived(getCronJobRuns(data.job.id));
	const runs = $derived(liveRuns.current ?? data.runs);
	const running = $derived(runs.some((run) => run.finishedAt === null));

	onMount(() => {
		title.set(job.name);
		const timer = setInterval(() => {
			if (running) {
				void liveRuns.refresh();
			}
		}, RUN_POLL_MS);
		return () => clearInterval(timer);
	});

	let submitting = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
	let expandedRunId = $state<string | null>(null);
</script>

<div class="space-y-6 p-5 md:p-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">{job.name}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {job.enabled ? job.schedule : "manual only"}
        · {job.kind === "exec" ? "host command" : describeCronJobTarget(job)}
        {#if job.lastRunAt}
          · last run {timeAgo(job.lastRunAt)}
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <form
        action="?/runNow"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't queue that run.",
          loading: "Queueing the run",
          success: "Run queued : it shows up below once it finishes.",
        })}
      >
        <Button size="sm" type="submit" variant="outline">
          <Play class="size-4" />
          Run now
        </Button>
      </form>
      <SaveButton form="cron-job-settings" pending={submitting} />
    </div>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    id="cron-job-settings"
    action="?/update"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't save that cron job.",
      loading: "Saving the cron job",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Saved.",
    })}
  >
    <CronJobFields
      canUseExec={data.canUseExec}
      remoteHosts={data.remoteHosts}
      values={{
        command: job.command,
        remoteHostId: job.remoteHostId,
        description: job.description,
        enabled: job.enabled,
        envVars: job.envVars ?? {},
        files: job.files,
        image: job.image,
        kind: job.kind,
        name: job.name,
        registryUrl: job.registryUrl,
        registryUsername: job.registryUsername,
        runtime: job.runtime,
        schedule: job.schedule,
        source: job.source,
        tag: job.tag,
        timeoutSeconds: job.timeoutSeconds,
      }}
    />
  </form>

  {#if runs.length > 0}
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
              <div class="mx-5 mb-3 max-h-64 overflow-y-auto rounded-md log-output">
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

  <section class="rounded-md border border-red-200 p-5 dark:border-red-900/40">
    <h2 class="eyebrow text-red-500">Danger zone</h2>
    <p class="text-text-muted mt-1 text-sm">
      Deleting this cron job also deletes its run history.
    </p>
    <form action="?/delete" bind:this={deleteForm} class="mt-3" method="POST">
      <Button
        class="border-red-200 bg-red-600/10 text-red-600 dark:border-red-600"
        onclick={() => {
          deleteDialogOpen = true;
        }}
        type="button"
        variant="outline"
      >
        <Trash2 class="size-4" />
        Delete cron job
      </Button>
    </form>
  </section>
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Delete"
  confirmPhrase={job.name}
  description={`Delete "${job.name}"? Its run history goes with it.`}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete cron job"
/>
