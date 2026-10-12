<script lang="ts">
	import { AlertTriangle, FolderKanban, Trash2 } from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import DeleteVolumesOption from "#lib/components/delete-volumes-option.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import IconPicker from "#lib/components/icon-picker.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import TemplateIcon from "#lib/components/template-icon.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import DeleteOverview from "./delete-overview.svelte";

	const { data, form } = $props();
	const stack = $derived(data.stack);

	onMount(() => title.set(`${stack.name} · Settings`));

	let renaming = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);
	let deleting = $state(false);
	let forceDelete = $state(false);
	let deleteVolumes = $state(false);
	const busy = $derived(data.deleteOverview.jobs.length > 0);
	let forceDeleteDialogOpen = $state(false);
	let detachError = $state("");
	let parentId = $derived(stack.parentId ?? "");
	let icon = $derived(stack.icon ?? "");
	let savingIcon = $state(false);
	let moving = $state(false);
</script>

<div>
  <section class="panel mb-4 rounded-xl">
    <div class="panel-head">
      <h2 class="eyebrow">Stack</h2>
      <SaveButton form="stack-details" pending={renaming} />
    </div>
    <form
      id="stack-details"
      action="?/rename"
      class="space-y-4 p-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Check the form for errors.",
        loading: "Saving the stack",
        onSettled: () => {
          renaming = false;
        },
        onStart: () => {
          renaming = true;
        },
        success: "Saved.",
      })}
    >
      {#if form?.error}
        <p class="text-sm text-red-500">{form.error}</p>
      {/if}
      <div>
        <label class={label} for="name">Name</label>
        <Input id="name" name="name" required type="text" value={stack.name} />
      </div>
      <div>
        <label class={label} for="slug">Slug</label>
        <Input
          id="slug"
          name="slug"
          pattern={"[a-z0-9-]{1,63}"}
          required
          type="text"
          value={stack.slug}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          Prefixes every member service's container name and public subdomain.
          Changing it takes effect on each service's next deploy.
        </p>
      </div>
      <div>
        <label class={label} for="description">Description</label>
        <Textarea
          class="resize-none"
          content={stack.description ?? ""}
          id="description"
          name="description"
          rows={2}
        />
      </div>
    </form>
  </section>

  <section class="panel mb-4 rounded-xl">
    <div class="panel-head">
      <h2 class="eyebrow">Icon</h2>
      <SaveButton form="stack-icon" pending={savingIcon} />
    </div>
    <form
      id="stack-icon"
      action="?/updateIcon"
      class="space-y-4 p-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the icon.",
        loading: "Saving the icon",
        onSettled: () => {
          savingIcon = false;
        },
        onStart: () => {
          savingIcon = true;
        },
        success: "Saved.",
      })}
    >
      <input name="icon" type="hidden" value={icon}>
      <TemplateIcon class="size-14" fallback={FolderKanban} icon={icon || null} />
      <IconPicker icons={data.icons} storedWith="stack" bind:icon />
    </form>
  </section>

  <section class="panel mb-4 rounded-xl">
    <div class="panel-head">
      <h2 class="eyebrow">Nested in</h2>
      <SaveButton form="stack-parent" label="Move" pending={moving} />
    </div>
    <form
      id="stack-parent"
      action="?/move"
      class="space-y-4 p-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't move the stack.",
        loading: "Moving the stack",
        onSettled: () => {
          moving = false;
        },
        onStart: () => {
          moving = true;
        },
        success: "Stack moved.",
      })}
    >
      <input name="parentId" type="hidden" value={parentId}>
      <div>
        <label class={label} for="parentId">Parent stack</label>
        <SelectRoot type="single" bind:value={parentId}>
          <SelectTrigger class="w-full" id="parentId">
            {data.parentOptions.find((o) => o.id === parentId)?.path ?? "None, a top-level stack"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem label="None, a top-level stack" value="" />
            {#each data.parentOptions as option (option.id)}
              <SelectItem label={option.path} value={option.id} />
            {/each}
          </SelectContent>
        </SelectRoot>
        <p class="text-text-subtle mt-1.5 text-xs">
          A substack shows inside its parent's page, tree and diagram. Its
          services keep their own slugs and hostnames; every service still
          reaches every other by slug, nested or not.
        </p>
      </div>
    </form>
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
          Deletes every service in this stack and their containers.
          Irreversible.
        </p>
      </div>
    </div>
    <div class="p-4">
      <form
        action="?/delete"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the stack.",
          loading: "Deleting the stack",
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
          success: "Stack deleted.",
        })}
      >
        <input name="force" type="hidden" value={forceDelete ? "true" : "false"} />
        <input name="deleteVolumes" type="hidden" value={deleteVolumes ? "true" : "false"} />
        <Button
          class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
          disabled={deleting}
          onclick={() => {
            deleteVolumes = false;
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
          Delete this stack
        </Button>
      </form>
    </div>
  </section>
</div>

<ConfirmDialog
  confirmLabel={busy ? "Force delete" : "Delete stack"}
  confirmPhrase={stack.name}
  description="This can't be undone. Here's what goes:"
  onConfirm={async () => {
    forceDelete = busy;
    await tick();
    deleteForm?.requestSubmit();
  }}
  title="Delete {stack.name}?"
  bind:open={deleteDialogOpen}
>
  <DeleteOverview {deleteVolumes} overview={data.deleteOverview} />
  {#if data.deleteOverview.volumes.length > 0}
    <DeleteVolumesOption bind:checked={deleteVolumes} />
  {/if}
</ConfirmDialog>

<ConfirmDialog
  confirmLabel="Delete anyway"
  description={`${detachError} Deleting anyway cancels any job still running for it and removes Homerun's records for this stack : any workload still on the host has to be removed by hand.`}
  onConfirm={async () => {
    forceDelete = true;
    await tick();
    deleteForm?.requestSubmit();
  }}
  title="Delete the stack anyway?"
  bind:open={forceDeleteDialogOpen}
/>
