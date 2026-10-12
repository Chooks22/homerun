<script lang="ts">
	import { AlertTriangle, Stethoscope, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import Alert from "#lib/components/alert.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import SaveButton from "#lib/components/save-button.svelte";
	import SelfTestChecks from "#lib/components/self-test-checks.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationFields from "#lib/components/workstation-fields.svelte";
	import { testWorkstation } from "#lib/remote/workstations.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast, toastError } from "#lib/toast.js";
	import type { WorkstationCheck } from "#lib/workstation-self-test.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const ws = $derived(data.workstation);

	onMount(() => title.set(`${ws.name} · Settings`));

	let saving = $state(false);
	let deleting = $state(false);
	let deleteVolume = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);

	let checks = $state<WorkstationCheck[] | null>(null);
	let testing = $state(false);

	async function selfTestCallback() {
		testing = true;
		try {
			checks = await testWorkstation(ws.id);
		} finally {
			testing = false;
		}
		const failed = checks.filter((check) => !check.ok).length;
		if (failed > 0) {
			throw new Error(
				failed === 1 ? "1 check failed." : `${failed} checks failed.`,
			);
		}
	}

	function handleSelfTest() {
		return toast.promise(selfTestCallback(), {
			error: (error) => toastError(error, "Couldn't run the self-test."),
			loading: "Testing the workstation",
			success: "Every check passed.",
		});
	}
</script>

<div class="space-y-4">
  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    id="workstation-settings"
    action="?/save"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Check the form for errors.",
      loading: "Saving the workstation",
      onSettled: () => {
        saving = false;
      },
      onStart: () => {
        saving = true;
      },
      success: "Saved. Start the workstation again to apply it.",
    })}
  >
    <section class="panel rounded-xl">
      <div class="panel-head">
        <h2 class="eyebrow">Workstation</h2>
        <SaveButton form="workstation-settings" pending={saving} />
      </div>
      <div class="p-4">
        <label class={labelClass} for="name">Name</label>
        <Input id="name" name="name" required type="text" value={ws.name} />
        <p class="text-text-subtle mt-1.5 text-xs">
          The hostname ({data.hostname}) and where it runs are fixed at
          creation.
        </p>
      </div>
    </section>

    <WorkstationFields providers={data.gitProviders} values={ws} />
  </form>

  <section class="panel rounded-xl">
    <div class="panel-head">
      <h2 class="eyebrow">Self-test</h2>
      <Button disabled={testing} onclick={handleSelfTest} size="sm" variant="outline">
        {#if testing}
          <Spinner />
        {:else}
          <Stethoscope class="size-4" />
        {/if}
        Run self-test
      </Button>
    </div>
    <div class="p-4">
      {#if checks}
        <SelfTestChecks {checks} />
      {:else}
        <p class="text-text-subtle text-xs">
          Checks the container runs, an agent host's published port answers,
          {data.hostname} resolves, and Traefik routes it to the IDE with a
          valid certificate.
        </p>
      {/if}
    </div>
  </section>

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
          Removes the container. The home volume goes too only when you ask.
        </p>
      </div>
    </div>
    <div class="space-y-4 p-4">
      <label class="flex items-start gap-3">
        <Checkbox bind:checked={deleteVolume} class="mt-0.5" />
        <span>
          <span class="text-text text-sm font-medium">Also delete the home volume</span>
          <span class="text-text-subtle block text-xs">
            Everything under {ws.homePath}, the cloned repository and any
            uncommitted work included.
          </span>
        </span>
      </label>
      <form
        action="?/delete"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the workstation.",
          loading: "Deleting the workstation",
          onSettled: () => {
            deleting = false;
          },
          onStart: () => {
            deleting = true;
          },
          success: "Workstation deleted.",
        })}
      >
        <input name="volume" type="hidden" value={deleteVolume ? "true" : "false"} />
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
          Delete this workstation
        </Button>
      </form>
    </div>
  </section>
</div>

<ConfirmDialog
  confirmLabel="Delete workstation"
  description={deleteVolume
    ? "The container and its home volume are removed. Uncommitted work is lost. This can't be undone."
    : "The container is removed. Its home volume stays on the host."}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete {ws.name}?"
  bind:open={deleteDialogOpen}
/>
