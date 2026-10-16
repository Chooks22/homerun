<script lang="ts">
	import { Trash2 } from "@lucide/svelte";
	import Alert from "#lib/components/alert.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Label } from "#lib/components/ui/label/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const repo = $derived(data.repository);

	let saving = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
</script>

<div class="space-y-6">
  {#if form?.error}
    <Alert>{form.error}</Alert>
  {/if}

  <form
    id="repository-settings"
    action="?/save"
    class="space-y-6"
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
    <section class="panel space-y-4 rounded-md p-5">
      <CheckBox
        checked={repo.pipelinesEnabled}
        helperText="Reads its runs every five minutes with the connection of whoever added it. Sync now works either way."
        id="pipelinesEnabled"
        label="Sync CI runs"
        name="pipelinesEnabled"
      />
      <div>
        <label class={labelClass} for="rates">Runner rates, dollars per minute</label>
        <Textarea
          class="font-mono"
          value={repo.pipelineRates ? data.defaultRates : ""}
          id="rates"
          name="rates"
          placeholder={data.defaultRates || "self-hosted = 0"}
          rows={4}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          One <span class="font-mono">label = rate</span> per line. A job costs its minutes, rounded up,
          times the rate of the first line whose label starts one of its runner labels; no match costs
          nothing. Leave it empty for the defaults: GitHub's hosted runner prices on GitHub, nothing
          elsewhere. Saving re-costs every stored run.
        </p>
      </div>
    </section>

    <section class="panel rounded-md p-5">
      <h2 class={labelClass}>Linked services</h2>
      <p class="text-text-subtle mb-3 text-xs">
        A linked service shows this repository's runs under its Observability → Pipelines, files its
        CI traces, and links its errors' stack frames to this repository's source, whether it's built
        from it or runs an image. A service links to one repository; ticking it here moves it.
      </p>
      {#if data.services.length === 0}
        <p class="text-text-muted text-sm">No service yet.</p>
      {:else}
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {#each data.services as svc (svc.id)}
            <Label
              class="has-aria-checked:border-accent has-aria-checked:bg-accent-light flex items-start gap-3 rounded-md border p-3 hover:bg-muted/50"
            >
              <Checkbox checked={svc.linkedHere} name="serviceIds" value={svc.id} />
              <span class="grid min-w-0 gap-1 font-normal">
                <span class="truncate text-sm leading-none font-medium">{svc.name}</span>
                {#if svc.linkedElsewhere}
                  <span class="text-text-subtle text-xs">Linked to another repository</span>
                {/if}
              </span>
            </Label>
          {/each}
        </div>
      {/if}
    </section>

    <div class="flex justify-end">
      <SaveButton form="repository-settings" pending={saving} />
    </div>
  </form>

  <section class="rounded-md border border-red-200 p-5 dark:border-red-900/40">
    <h2 class="eyebrow text-red-500">Danger zone</h2>
    <p class="text-text-muted mt-1 text-sm">
      Stop watching this repository: its stored runs are deleted and its services unlinked. Traces
      already exported stay until they expire.
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
        Stop watching
      </Button>
    </form>
  </section>
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Stop watching"
  confirmPhrase={repo.fullName}
  description={`Stop watching "${repo.fullName}"? Its stored runs are deleted.`}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Stop watching repository"
/>
