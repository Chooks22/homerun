<script lang="ts">
	import { AlertTriangle, Check, Plus, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationFields from "#lib/components/workstation-fields.svelte";
	import WorkstationPresetHead from "#lib/components/workstation-preset-head.svelte";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();
	const preset = $derived(data.preset);

	onMount(() => title.set(`${preset.name} · Preset`));

	let saving = $state(false);
	let deleting = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);
</script>

<div class="space-y-6 p-6 md:p-8">
  <div class="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">{preset.name}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        A workstation preset. Saving it changes nothing that already runs.
      </p>
    </div>
    <Button href={`${resolve("workstations/new")}?preset=${encodeURIComponent(preset.id)}`}>
      <Plus class="size-4" />New workstation from it
    </Button>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    action="?/save"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't save the preset.",
      loading: "Saving the preset",
      onSettled: () => {
        saving = false;
      },
      onStart: () => {
        saving = true;
      },
      success: "Preset saved.",
    })}
  >
    {#key preset.id}
      <WorkstationFields
        hosts={data.hosts}
        providers={data.gitProviders}
        values={preset}
        wall={data.wall}
      >
        <WorkstationPresetHead description={preset.description} name={preset.name} />
      </WorkstationFields>
    {/key}

    <Button disabled={saving} type="submit">
      {#if saving}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Save preset
    </Button>
  </form>

  <section class="rounded-xl border border-red-300/60 dark:border-red-900/50">
    <div class="flex items-center gap-3 border-b border-red-300/40 px-4 py-3 dark:border-red-900/40">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
        <AlertTriangle class="size-4" />
      </span>
      <div>
        <h2 class="text-sm font-semibold text-red-600 dark:text-red-400">
          Danger zone
        </h2>
        <p class="text-text-muted text-xs">
          Workstations created from this preset keep their own settings.
        </p>
      </div>
    </div>
    <div class="p-4">
      <form
        action="?/delete"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the preset.",
          loading: "Deleting the preset",
          onSettled: () => {
            deleting = false;
          },
          onStart: () => {
            deleting = true;
          },
          success: "Preset deleted.",
        })}
      >
        <Button
          class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
          disabled={deleting}
          onclick={() => {
            deleteDialogOpen = true;
          }}
          type="button"
          variant="outline"
        >
          {#if deleting}
            <Spinner />
          {:else}
            <Trash2 class="size-4" />
          {/if}
          Delete this preset
        </Button>
      </form>
    </div>
  </section>
</div>

<ConfirmDialog
  confirmLabel="Delete preset"
  description="The preset goes. Workstations created from it are untouched."
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete {preset.name}?"
  bind:open={deleteDialogOpen}
/>
