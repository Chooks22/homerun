<script lang="ts">
	import { AlertTriangle, Trash2Icon, TriangleAlertIcon } from "@lucide/svelte";
	import { tick } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import DeleteVolumesOption from "#lib/components/delete-volumes-option.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import type { ActiveJob } from "#lib/services/service-lifecycle.service.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		activeJobs: ActiveJob[];
		name: string;
	}

	const { activeJobs, name }: Props = $props();
	const busy = $derived(activeJobs.length > 0);

	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);
	let deleting = $state(false);
	let forceDelete = $state(false);
	let deleteVolumes = $state(false);
	let forceDeleteDialogOpen = $state(false);
	let detachError = $state("");
</script>

<section class="bg-surface rounded-md border border-red-200 dark:border-red-900/40">
  <div class="flex items-center gap-3 border-b border-red-100 px-5 py-4 dark:border-red-900/30">
    <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
      <TriangleAlertIcon class="size-4" />
    </div>
    <div>
      <h2 class="text-sm font-semibold text-red-600 dark:text-red-400">
        Danger zone
      </h2>
      <p class="text-text-muted text-xs">
        Irreversible. Removes the container and all deployment history.
      </p>
    </div>
  </div>
  <div class="p-5">
    <form
      action="?/delete"
      class="flex flex-wrap items-center justify-between gap-4"
      method="POST"
      bind:this={deleteForm}
      use:enhance={enhanceToast({
        error: "Couldn't delete the service.",
        loading: "Deleting the service",
        onFailure: (result) => {
          deleting = false;
          if (result?.detachFailed && !forceDelete) {
            detachError = String(result.error ?? "");
            forceDeleteDialogOpen = true;
          }
          forceDelete = false;
        },
        onStart: () => {
          deleting = true;
        },
        success: "Service deleted.",
      })}
    >
      <input name="force" type="hidden" value={forceDelete ? "true" : "false"} />
      <input name="deleteVolumes" type="hidden" value={deleteVolumes ? "true" : "false"} />
      <div>
        <p class="text-text text-sm font-medium">Delete this service</p>
        <p class="text-text-muted mt-0.5 text-xs">
          Its container will be stopped and removed. This can't be undone.
        </p>
      </div>
      <Button
        disabled={deleting}
        onclick={() => {
          deleteVolumes = false;
          deleteDialogOpen = true;
        }}
        type="button"
        variant="destructive"
      >
        {#if deleting}
          <Spinner />
          Deleting…
        {:else}
          <Trash2Icon class="size-4" />
          Delete service
        {/if}
      </Button>
    </form>
  </div>
</section>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel={busy ? "Force delete" : "Delete service"}
  confirmPhrase={name}
  description={`Deleting "${name}" stops and removes its container and erases its deployment history. This can't be undone.`}
  onConfirm={async () => {
    forceDelete = busy;
    await tick();
    deleteForm?.requestSubmit();
  }}
  title="Delete service"
>
  {#if busy}
    <div class="flex gap-2 rounded-md border border-amber-300/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:border-amber-900/50 dark:text-amber-400">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <div>
        <p class="font-medium">Still running for this service</p>
        <ul class="mt-1 list-disc pl-4 text-xs">
          {#each activeJobs as entry (entry.id)}
            <li>{entry.title}</li>
          {/each}
        </ul>
        <p class="mt-1 text-xs">
          Force deleting cancels them first. Anything they already started on
          the host may need removing by hand.
        </p>
      </div>
    </div>
  {/if}
  <DeleteVolumesOption bind:checked={deleteVolumes} />
</ConfirmDialog>

<ConfirmDialog
  bind:open={forceDeleteDialogOpen}
  confirmLabel="Delete anyway"
  description={`${detachError} Deleting anyway cancels any job still running for it and removes Homerun's record of "${name}" : if its workload still exists on the host, remove it yourself.`}
  onConfirm={async () => {
    forceDelete = true;
    await tick();
    deleteForm?.requestSubmit();
  }}
  title="Delete the record anyway?"
/>
