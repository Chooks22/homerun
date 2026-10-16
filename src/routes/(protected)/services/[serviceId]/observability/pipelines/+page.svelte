<script lang="ts">
	import { RefreshCw, Workflow } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import PipelineRunList from "#lib/components/pipelines/pipeline-run-list.svelte";
	import PipelineStats from "#lib/components/pipelines/pipeline-stats.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import { PIPELINE_PROVIDER_LABELS } from "#lib/pipelines/list.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();
	const svc = $derived(data.service);
	const overview = $derived(data.overview);

	onMount(() => title.set(`${svc.name} · Pipelines`));

	let saving = $state(false);
	let syncing = $state(false);

	function traceHref(traceId: string): string {
		return resolve(
			"/(protected)/services/[serviceId]/observability/traces/[traceId]",
			{ serviceId: svc.id, traceId },
		);
	}
</script>

{#if svc.buildSource !== "git" || !overview}
  <EmptyState
    icon={Workflow}
    subtitle="Pipelines read the CI runs of the repo a service builds from. Switch the service to a git source to use them."
    title="Not built from a git repo"
  />
{:else}
  <div class="space-y-6">
    {#if overview.providerError}
      <Alert title="Homerun can't read this repo's CI.">{overview.providerError}</Alert>
    {:else if svc.pipelinesError}
      <Alert title="The last sync failed.">{svc.pipelinesError}</Alert>
    {/if}

    <section class="panel rounded-md">
      <PanelHeader
        description={overview.provider
          ? `${PIPELINE_PROVIDER_LABELS[overview.provider]} runs of ${svc.gitRepo ?? svc.gitUrl}, synced every five minutes${svc.pipelinesSyncedAt ? `, last ${timeAgo(svc.pipelinesSyncedAt)}` : ""}. Finished runs show up under Traces too.`
          : "CI runs of the service's repo, synced every five minutes."}
        icon={Workflow}
        title="Pipelines"
      >
        {#snippet trailing()}
          {#if svc.pipelinesEnabled}
            <form
              action="?/sync"
              method="POST"
              use:enhance={enhanceToast({
                error: "Couldn't sync the pipelines.",
                loading: "Syncing the pipelines",
                onSettled: () => {
                  syncing = false;
                },
                onStart: () => {
                  syncing = true;
                },
                success: (result) =>
                  result?.updated
                    ? `Synced ${result.updated} ${result.updated === 1 ? "run" : "runs"}.`
                    : "Already up to date.",
              })}
            >
              <Button disabled={syncing} size="sm" type="submit" variant="outline">
                {#if syncing}
                  <Spinner />
                {:else}
                  <RefreshCw class="size-4" />
                {/if}
                Sync now
              </Button>
            </form>
          {/if}
          <SaveButton form="pipelines-settings" pending={saving} />
        {/snippet}
      </PanelHeader>
      <form
        id="pipelines-settings"
        action="?/settings"
        class="space-y-4 p-5"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't save the pipeline settings.",
          loading: "Saving the pipeline settings",
          onSettled: () => {
            saving = false;
          },
          onStart: () => {
            saving = true;
          },
          success: (result) =>
            result?.enabled
              ? "Pipelines are on, the first sync is running."
              : "Pipeline settings saved.",
        })}
      >
        <CheckBox
          checked={svc.pipelinesEnabled}
          helperText="Reads the repo's runs with the service owner's git provider connection. GitHub Actions, GitLab CI and Gitea Actions (1.24 or later)."
          id="pipelinesEnabled"
          label="Sync CI runs"
          name="pipelinesEnabled"
        />
        <div>
          <label class={labelClass} for="rates">Runner rates, dollars per minute</label>
          <Textarea
            class="font-mono"
            content={overview.ratesCustom ? data.ratesText : ""}
            id="rates"
            name="rates"
            placeholder={data.ratesText || "self-hosted = 0"}
            rows={4}
          />
          <p class="text-text-subtle mt-1.5 text-xs">
            One <span class="font-mono">label = rate</span> per line. A job costs its minutes, rounded up,
            times the rate of the first line whose label starts one of its runner labels; no match costs
            nothing. Leave it empty for the defaults: GitHub's hosted runner prices on GitHub, nothing
            elsewhere. Saving re-costs every stored run.
          </p>
        </div>
      </form>
    </section>

    <PipelineStats
      allTime={overview.allTime}
      window={overview.window}
      windowDays={data.windowDays}
      workflows={overview.workflows}
    />

    <PipelineRunList
      emptySubtitle={svc.pipelinesEnabled
        ? "Runs show up here after the first sync."
        : "Turn on Sync CI runs to read this repo's runs."}
      listing={data.listing}
      searched={data.searched}
      {traceHref}
    />
  </div>
{/if}
