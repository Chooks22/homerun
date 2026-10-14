<script lang="ts">
	import { ArrowLeft, Bot, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import PermissionPicker from "#lib/components/permission-picker.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import type { Permissions } from "#lib/permissions.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("New service account"));

	let permissions = $state<Permissions>({});
	let creating = $state(false);
</script>

<div class="space-y-6 p-5 md:p-6">
  <a
    class="text-text-muted hover:text-text inline-flex items-center gap-1 text-sm"
    href={resolve("service-accounts")}
  >
    <ArrowLeft class="size-4" />
    All service accounts
  </a>

  <section class="panel rounded-md">
    <PanelHeader
      description="It has no password and can't sign in. Mint an API key for it next, then tick it in a login wall's allowed users."
      icon={Bot}
      title="New service account"
    />
    <form
      action="?/create"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't create the service account.",
        loading: "Creating the service account",
        onSettled: () => {
          creating = false;
        },
        onStart: () => {
          creating = true;
        },
        success: "Service account created.",
      })}
    >
      <div class="max-w-md">
        <label class="text-text mb-1.5 block text-sm font-medium" for="name">Name</label>
        <Input id="name" name="name" placeholder="e.g. GitHub Actions e2e" required type="text" />
      </div>

      <div>
        <p class="text-text mb-1.5 text-sm font-medium">Dashboard and API access</p>
        <p class="text-text-subtle mb-3 text-xs">
          None by default: its keys then only get through login walls. Grant
          an area only if the job also calls the REST API.
        </p>
        <PermissionPicker grantable={data.grantable} bind:value={permissions} />
      </div>

      <div class="flex justify-end">
        <Button disabled={creating} type="submit">
          {#if creating}
            <Spinner />
          {:else}
            <Plus class="size-4" />
          {/if}
          Create
        </Button>
      </div>
    </form>
  </section>
</div>
