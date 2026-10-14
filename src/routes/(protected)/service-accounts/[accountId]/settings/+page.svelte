<script lang="ts">
	import { Ban, Bot, CircleCheck, Trash2, TriangleAlert } from "@lucide/svelte";
	import { onMount } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import PermissionPicker from "#lib/components/permission-picker.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import type { Permissions } from "#lib/permissions.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data } = $props();

	onMount(() => title.set(`${data.account.name} · Settings`));

	let permissions = $derived<Permissions>(data.account.permissions);
	let saving = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Changes apply to the account's keys from their next request."
      icon={Bot}
      title="Service account"
    >
      {#snippet trailing()}
        <SaveButton form="service-account-settings" pending={saving} />
      {/snippet}
    </PanelHeader>
    <form
      id="service-account-settings"
      class="space-y-4 p-5"
      action="?/update"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the service account.",
        loading: "Saving the service account",
        onSettled: () => {
          saving = false;
        },
        onStart: () => {
          saving = true;
        },
        success: "Service account saved.",
      })}
    >
      <div class="max-w-md">
        <label class="text-text mb-1.5 block text-sm font-medium" for="name">Name</label>
        <Input id="name" name="name" required type="text" value={data.account.name} />
      </div>
      <div>
        <p class="text-text mb-1.5 text-sm font-medium">Dashboard and API access</p>
        <p class="text-text-subtle mb-3 text-xs">
          None means its keys only get through the login walls that list it.
        </p>
        <PermissionPicker grantable={data.grantable} bind:value={permissions} />
      </div>
    </form>
  </section>

  <section class="bg-surface rounded-md border border-red-200 dark:border-red-900/40">
    <div class="flex items-center gap-3 border-b border-red-100 px-5 py-4 dark:border-red-900/30">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
        <TriangleAlert class="size-4" />
      </div>
      <div>
        <h2 class="text-sm font-semibold text-red-600 dark:text-red-400">Danger zone</h2>
        <p class="text-text-muted text-xs">
          Disabling refuses its keys right away; login-wall cookies it already
          holds stop working within five minutes.
        </p>
      </div>
    </div>
    <div class="divide-border divide-y">
      <form
        action="?/setDisabled"
        class="flex flex-wrap items-center justify-between gap-4 p-5"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't change the service account.",
          loading: data.account.disabled ? "Enabling the service account" : "Disabling the service account",
          success: (result) => result?.disabled ? "Service account disabled." : "Service account enabled.",
        })}
      >
        <input name="disabled" type="hidden" value={data.account.disabled ? "false" : "true"} />
        <div>
          <p class="text-text text-sm font-medium">
            {data.account.disabled ? "Enable this service account" : "Disable this service account"}
          </p>
          <p class="text-text-muted mt-0.5 text-xs">
            {data.account.disabled
              ? "Its keys work again from their next request."
              : "Keeps it and its keys, refused until you enable it again."}
          </p>
        </div>
        <Button type="submit" variant={data.account.disabled ? "outline" : "destructive"}>
          {#if data.account.disabled}
            <CircleCheck class="size-4" />
            Enable
          {:else}
            <Ban class="size-4" />
            Disable
          {/if}
        </Button>
      </form>
      <form
        action="?/delete"
        class="flex flex-wrap items-center justify-between gap-4 p-5"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the service account.",
          loading: "Deleting the service account",
          success: "Service account deleted.",
        })}
      >
        <div>
          <p class="text-text text-sm font-medium">Delete this service account</p>
          <p class="text-text-muted mt-0.5 text-xs">
            Revokes its keys. Anything it created is handed over to you; its
            activity stays in the log.
          </p>
        </div>
        <Button onclick={() => (deleteDialogOpen = true)} type="button" variant="destructive">
          <Trash2 class="size-4" />
          Delete
        </Button>
      </form>
    </div>
  </section>
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Delete service account"
  confirmPhrase={data.account.name}
  description={`Deleting "${data.account.name}" revokes every key it has. This can't be undone.`}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete service account"
/>
