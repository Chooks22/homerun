<script lang="ts">
	import { ArrowLeft, KeyRound } from "@lucide/svelte";
	import { onMount } from "svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import PermissionPicker from "#lib/components/permission-picker.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import { SECRET_MASK } from "#lib/formatting.js";
	import type { Permissions } from "#lib/permissions.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set(data.apiKey.name ?? "API key"));

	let allPermissions = $derived(data.apiKey.permissions === null);
	let permissions = $derived<Permissions>(data.apiKey.permissions ?? {});
	let saving = $state(false);
</script>

<div class="space-y-6">
  <a
    class="text-text-muted hover:text-text inline-flex items-center gap-1 text-sm"
    href={resolve("/(protected)/profile/api-keys")}
  >
    <ArrowLeft class="size-4" />
    All API keys
  </a>

  <section class="panel rounded-md">
    <PanelHeader
      description={`${data.apiKey.prefix ?? ""}${data.apiKey.start ?? SECRET_MASK}… · Changes apply to the key's next request; the secret stays the same.`}
      icon={KeyRound}
      title="Edit API key"
    >
      {#snippet trailing()}
        <SaveButton form="api-key-settings" pending={saving} />
      {/snippet}
    </PanelHeader>
    <form
      id="api-key-settings"
      class="space-y-4 p-5"
      action="?/update"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't update the key.",
        loading: "Saving the key",
        onSettled: () => {
          saving = false;
        },
        onStart: () => {
          saving = true;
        },
        success: "Key saved.",
      })}
    >
      <div class="max-w-md">
        <label class="mb-1.5 block text-sm font-medium text-text" for="name">Name</label>
        <Input id="name" name="name" type="text" value={data.apiKey.name ?? ""} />
      </div>

      <CheckBox
        helperText="Dangerous: the key can do everything your account can, including whatever you're granted later. Pick only what it needs unless you really mean it."
        id="allPermissions"
        label="Allow all permissions"
        name="allPermissions"
        bind:checked={allPermissions}
      />

      {#if !allPermissions}
        <PermissionPicker grantable={data.grantable} bind:value={permissions} />
      {/if}
    </form>
  </section>
</div>
