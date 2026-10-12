<script lang="ts">
	import { Clock, CloudUpload, Gauge, RefreshCw } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import JobQueuePanel from "#lib/components/job-queue-panel.svelte";
	import { describeCronJobTarget } from "#lib/cron-job-script.js";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Scheduling"));

	function formatDate(value: Date | string | null): string {
		if (!value) {
			return "never";
		}
		return new Date(value).toLocaleString();
	}
</script>

<div class="p-5 md:p-6">
  <div class="mb-8">
    <h1 class="text-text text-lg font-semibold tracking-tight">Scheduling</h1>
    <p class="text-text-muted mt-1 text-sm">
      The job queue plus cron redeploys, cron jobs, and backups
      activity across every service and volume, in one place.
    </p>
  </div>

  <div class="space-y-8">
    <!-- ═══ Job queue ═══ -->
    <ErrorBoundary title="The job queue didn't load.">
      <JobQueuePanel />
    </ErrorBoundary>

    <!-- ═══ Cron redeploys ═══ -->
    <section>
      <div class="mb-3 flex items-center gap-2">
        <RefreshCw class="text-accent size-4" />
        <h2 class="eyebrow">Cron redeploys</h2>
      </div>
      {#if data.cronServices.length === 0}
        <EmptyState
          icon={RefreshCw}
          subtitle="Turn on scheduled redeploys from a service's Settings tab."
          title="No services have cron redeploy enabled"
        />
      {:else}
        <div class="space-y-2.5">
          {#each data.cronServices as { stackName, service } (service.id)}
            <a
              class="panel hover:border-accent/40 flex flex-col gap-1 rounded-md p-4 transition-colors sm:flex-row sm:items-center sm:gap-4"
              href="{resolve('services')}/{service.id}/settings"
            >
              <div class="min-w-0 flex-1">
                <p class="text-text truncate text-sm font-semibold">
                  {service.name}
                  {#if stackName}
                    <span class="text-text-muted font-normal">· {stackName}</span>
                  {/if}
                </p>
                <p class="text-text-muted mt-0.5 truncate text-xs">
                  {service.cronSchedule}
                </p>
              </div>
              <p class="text-text-subtle shrink-0 text-xs">
                last run: {formatDate(service.cronLastRunAt)}
              </p>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    <!-- ═══ Cron jobs ═══ -->
    <section>
      <div class="mb-3 flex items-center gap-2">
        <Clock class="text-accent size-4" />
        <h2 class="eyebrow">Cron jobs</h2>
      </div>
      {#if data.cronJobs.length === 0}
        <EmptyState
          icon={Clock}
          subtitle="Create one from the Cron Jobs page to run a container or a host command on a schedule."
          title="No cron jobs are enabled"
        />
      {:else}
        <div class="space-y-2.5">
          {#each data.cronJobs as job (job.id)}
            <a
              class="panel hover:border-accent/40 flex flex-col gap-1 rounded-md p-4 transition-colors sm:flex-row sm:items-center sm:gap-4"
              href="{resolve('cron-jobs')}/{job.id}"
            >
              <div class="min-w-0 flex-1">
                <p class="text-text truncate text-sm font-semibold">
                  {job.name}
                </p>
                <p class="text-text-muted mt-0.5 truncate text-xs">
                  {job.schedule}
                  · {job.kind === "exec" ? "host command" : describeCronJobTarget(job)}
                </p>
              </div>
              <p class="text-text-subtle shrink-0 text-xs">
                last run: {formatDate(job.lastRunAt)}
              </p>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    <!-- ═══ Backups ═══ -->
    <section>
      <div class="mb-3 flex items-center gap-2">
        <CloudUpload class="text-accent size-4" />
        <h2 class="eyebrow">Backups</h2>
      </div>
      {#if data.backupVolumes.length === 0}
        <EmptyState
          icon={CloudUpload}
          subtitle="Configure a destination and schedule from a volume's page."
          title="No volumes have scheduled backups enabled"
        />
      {:else}
        <div class="space-y-2.5">
          {#each data.backupVolumes as vol (vol.id)}
            <a
              class="panel hover:border-accent/40 flex flex-col gap-1 rounded-md p-4 transition-colors sm:flex-row sm:items-center sm:gap-4"
              href="{resolve('storage')}/{vol.id}"
            >
              <div class="min-w-0 flex-1">
                <p class="text-text truncate text-sm font-semibold">
                  {vol.name}
                </p>
                <p class="text-text-muted mt-0.5 truncate text-xs">
                  {vol.backupSchedule}
                  · {vol.destinationName}
                </p>
              </div>
              <p class="text-text-subtle shrink-0 text-xs">
                last run: {formatDate(vol.backupLastRunAt)}
              </p>
            </a>
          {/each}
        </div>
      {/if}
    </section>

  </div>
</div>
