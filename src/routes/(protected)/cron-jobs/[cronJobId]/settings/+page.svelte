<script lang="ts">
	import { Trash2 } from "@lucide/svelte";
	import Alert from "#lib/components/alert.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import CronJobSettingsFields from "#lib/components/cron-job-settings-fields.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const job = $derived(data.job);

	let saving = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
</script>

<div class="space-y-6">
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
      error: "Couldn't save the settings.",
      loading: "Saving the settings",
      onSettled: () => {
        saving = false;
      },
      onStart: () => {
        saving = true;
      },
      success: "Settings saved.",
    })}
  >
    <CronJobSettingsFields
      values={{
        description: job.description,
        enabled: job.enabled,
        name: job.name,
        schedule: job.schedule,
        timeoutSeconds: job.timeoutSeconds,
      }}
    />
    <div class="flex justify-end">
      <SaveButton form="cron-job-settings" pending={saving} />
    </div>
  </form>

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
