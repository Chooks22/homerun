<script lang="ts">
	import {
		Ban,
		CircleCheck,
		GitBranch,
		Trash2,
		TriangleAlert,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data } = $props();

	onMount(() => title.set(`${data.provider.name} · Settings`));

	const isGithub = $derived(data.provider.kind === "github");
	const selfHostable = $derived(
		data.provider.kind === "gitlab" || data.provider.kind === "gitea",
	);

	let saving = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description={isGithub
        ? "The name only changes here: the GitHub App keeps its own name on GitHub."
        : "A new client secret applies from the next connect; leave it empty to keep the current one."}
      icon={GitBranch}
      title="Provider"
    >
      {#snippet trailing()}
        <SaveButton form="git-provider-settings" pending={saving} />
      {/snippet}
    </PanelHeader>
    <form
      id="git-provider-settings"
      class="grid gap-4 p-5 md:grid-cols-2"
      action="?/update"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the provider.",
        loading: "Saving the provider",
        onSettled: () => {
          saving = false;
        },
        onStart: () => {
          saving = true;
        },
        success: "Provider saved.",
      })}
    >
      <div>
        <label class="text-text mb-1.5 block text-sm font-medium" for="name">Name</label>
        <Input id="name" name="name" required type="text" value={data.provider.name} />
      </div>
      {#if selfHostable}
        <div>
          <label class="text-text mb-1.5 block text-sm font-medium" for="baseUrl">Base URL</label>
          <Input
            id="baseUrl"
            name="baseUrl"
            placeholder={data.provider.kind === "gitlab" ? "https://gitlab.com" : "https://gitea.example.com"}
            required={data.provider.kind === "gitea"}
            type="text"
            value={data.provider.baseUrl ?? ""}
          />
        </div>
      {/if}
      {#if !isGithub}
        <div>
          <label class="text-text mb-1.5 block text-sm font-medium" for="clientId">Client ID</label>
          <Input id="clientId" name="clientId" required type="text" value={data.provider.clientId} />
        </div>
        <div>
          <label class="text-text mb-1.5 block text-sm font-medium" for="clientSecret">Client secret</label>
          <Input
            id="clientSecret"
            name="clientSecret"
            autocomplete="new-password"
            placeholder="Unchanged"
            type="password"
          />
        </div>
      {/if}
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
          Services building from this provider's repos lose browsing, private
          clones and push webhooks.
        </p>
      </div>
    </div>
    <div class="divide-border divide-y">
      <form
        action="?/setEnabled"
        class="flex flex-wrap items-center justify-between gap-4 p-5"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't change the provider.",
          loading: data.provider.enabled ? "Disabling the provider" : "Enabling the provider",
          success: (result) => result?.enabled ? "Provider enabled." : "Provider disabled.",
        })}
      >
        <input name="enabled" type="hidden" value={data.provider.enabled ? "false" : "true"} />
        <div>
          <p class="text-text text-sm font-medium">
            {data.provider.enabled ? "Disable this provider" : "Enable this provider"}
          </p>
          <p class="text-text-muted mt-0.5 text-xs">
            {data.provider.enabled
              ? "Keeps it and everyone's connections, but nobody can connect or reconnect until it's enabled again."
              : "Lets people connect and reconnect again."}
          </p>
        </div>
        <Button type="submit" variant={data.provider.enabled ? "destructive" : "outline"}>
          {#if data.provider.enabled}
            <Ban class="size-4" />
            Disable
          {:else}
            <CircleCheck class="size-4" />
            Enable
          {/if}
        </Button>
      </form>
      <form
        action="?/delete"
        class="flex flex-wrap items-center justify-between gap-4 p-5"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the provider.",
          loading: "Deleting the provider",
          success: "Provider deleted.",
        })}
      >
        <div>
          <p class="text-text text-sm font-medium">Delete this provider</p>
          <p class="text-text-muted mt-0.5 text-xs">
            Everyone connected to it loses that connection.
            {#if isGithub}
              The GitHub App itself stays on GitHub; delete it there too.
            {/if}
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
  confirmLabel="Delete provider"
  confirmPhrase={data.provider.name}
  description={`Delete "${data.provider.name}"? Anyone connected to it loses that connection. This can't be undone.`}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete git provider"
/>
