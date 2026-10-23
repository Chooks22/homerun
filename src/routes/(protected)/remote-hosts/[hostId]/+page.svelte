<script lang="ts">
	import { ChevronDown, ChevronLeft, Server, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Label } from "#lib/components/ui/label/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { settings } from "#lib/settings.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set(data.host.name));

	let showTls = $state(false);
	let submitting = $state(false);
	let savingBuilds = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
</script>

<div class="p-5 md:p-6">
  <a
    class="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"
    href={resolve('remote-hosts')}
  ><ChevronLeft class="size-4" />Remote Hosts</a>

  <div class="mb-6 flex items-center gap-3">
    <div class="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
      <Server class="size-5" />
    </div>
    <div class="min-w-0">
      <h1 class="truncate text-text text-lg font-semibold tracking-tight">{data.host.name}</h1>
      <p class="text-sm text-text-muted">
        {data.host.kind === "agent" ? "Homerun Agent" : "Direct Docker connection"}
      </p>
    </div>
  </div>

  {#if data.host.kind === "agent"}
    <div class="mb-6 flex items-center gap-2 rounded-md panel p-4 text-sm">
      {#if data.agentStatus?.reachable}
        <span class="inline-block size-2 rounded-full bg-green-500"></span>
        <span class="text-text">Online</span>
        <span class="text-text-subtle">· agent v{data.agentStatus.version}</span>
      {:else}
        <span class="inline-block size-2 rounded-full bg-red-500"></span>
        <span class="text-red-600 dark:text-red-400">
          Unreachable{data.agentStatus?.error ? ` : ${data.agentStatus.error}` : ""}
        </span>
      {/if}
    </div>
  {/if}

  <section class="panel mb-6 rounded-md">
    <PanelHeader title="Connection">
      {#snippet trailing()}
        <SaveButton form="remote-host-settings" pending={submitting} />
      {/snippet}
    </PanelHeader>
    <form
      id="remote-host-settings"
      class="space-y-4 p-5"
      action="?/update"
      method="POST"
      use:enhance={enhanceToast({
        error: "Check the form for errors.",
        loading: "Saving the host",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Remote host updated.",
      })}
    >
      {#if form?.error}
        <p class="text-sm text-red-500">{form.error}</p>
      {/if}
      <div>
        <Label class="mb-1.5" for="name">Name</Label>
        <Input id="name" name="name" required type="text" value={data.host.name} />
      </div>

      {#if data.host.kind === "agent"}
        <div>
          <Label class="mb-1.5" for="agentUrl">Agent URL</Label>
          <Input
            class=""
            id="agentUrl"
            name="agentUrl"
            placeholder="http://192.168.1.50:7420"
            required
            type="text"
            value={data.host.agentUrl}
          />
          <p class="mt-1.5 text-xs text-text-subtle">
            The worker's reachable base URL, port 7420 unless WORKER_PORT says otherwise.
          </p>
        </div>
        <div>
          <Label class="mb-1.5" for="agentToken">Agent token</Label>
          <Input
            class=""
            id="agentToken"
            name="agentToken"
            placeholder="Leave blank to keep current"
            type="password"
          />
          <p class="mt-1.5 text-xs text-text-subtle">
            Only needed if the agent's token changed, or the URL above did :
            both get re-verified whenever either one moves.
          </p>
        </div>
      {:else}
        <div>
          <Label class="mb-1.5" for="dockerHost">Docker host</Label>
          <Input
            class=""
            id="dockerHost"
            name="dockerHost"
            placeholder="tcp://192.168.1.50:2376"
            required
            type="text"
            value={data.host.dockerHost}
          />
          <p class="mt-1.5 text-xs text-text-subtle">
            <code>tcp://host:port</code>
            (add TLS certs below for a TLS-secured daemon) or
            <code>ssh://user@host</code>
            (uses the system's own SSH agent : no key field here).
          </p>
        </div>

        <Button
          class="h-auto p-0"
          onclick={() => {
            showTls = !showTls;
          }}
          variant="link"
        >
          <ChevronDown
            class="size-3.5 transition-transform {showTls ? 'rotate-180' : ''}"
          />
          TLS client certificate (optional, tcp:// only)
        </Button>
        {#if showTls}
          <div class="space-y-3">
            <div>
              <Label class="mb-1.5" for="tlsCa">CA certificate</Label>
              <Textarea
                class="resize-none"
                id="tlsCa"
                name="tlsCa"
                placeholder="Leave blank to keep current"
                rows={3}
              />
            </div>
            <div>
              <Label class="mb-1.5" for="tlsCert">Client certificate</Label>
              <Textarea
                class="resize-none"
                id="tlsCert"
                name="tlsCert"
                placeholder="Leave blank to keep current"
                rows={3}
              />
            </div>
            <div>
              <Label class="mb-1.5" for="tlsKey">Client key</Label>
              <Textarea
                class="resize-none"
                id="tlsKey"
                name="tlsKey"
                placeholder="Leave blank to keep current"
                rows={3}
              />
            </div>
          </div>
        {/if}
      {/if}
    </form>
  </section>

  <section class="panel mb-6 rounded-md">
    <PanelHeader title="Builds">
      {#snippet trailing()}
        <SaveButton form="remote-host-builds" pending={savingBuilds} />
      {/snippet}
    </PanelHeader>
    <form
      id="remote-host-builds"
      class="space-y-4 p-5"
      action="?/updateBuilds"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the build limit.",
        loading: "Saving the build limit",
        onSettled: () => {
          savingBuilds = false;
        },
        onStart: () => {
          savingBuilds = true;
        },
        success: "Build limit saved.",
      })}
    >
      <div>
        <Label class="mb-1.5" for="maxConcurrentBuilds">Concurrent builds</Label>
        <Input
          id="maxConcurrentBuilds"
          max={settings.docker.maxBuildConcurrency}
          min={0}
          name="maxConcurrentBuilds"
          placeholder={`${data.buildConcurrency || "No limit"} (instance default)`}
          type="number"
          value={data.host.maxConcurrentBuilds ?? ""}
        />
        <p class="mt-1.5 text-xs text-text-subtle">
          How many git builds run on this server at once, 0 for no limit. Leave
          blank to follow the default on
          <a class="underline" href={resolve('settings/docker')}>Settings → Docker</a>.
        </p>
      </div>
    </form>
  </section>

  <div class="rounded-md border border-red-500/30 bg-red-500/5 p-5">
    <h2 class="eyebrow">Danger zone</h2>
    <p class="mt-1 text-xs text-text-muted">
      Services deployed to this host keep running there : they just won't be
      manageable from here anymore.
    </p>
    <form
      class="mt-3"
      action="?/delete"
      method="POST"
      bind:this={deleteForm}
      use:enhance={enhanceToast({
        error: "Couldn't delete the host.",
        loading: "Deleting the host",
        success: "Remote host deleted.",
      })}
    >
      <Button
        onclick={() => {
          deleteDialogOpen = true;
        }}
        type="button"
        variant="destructive"
      >
        <Trash2 class="size-4" />
        Delete this host
      </Button>
    </form>
  </div>
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Delete"
  description={`Delete "${data.host.name}"? Services deployed to it keep running there : they just won't be manageable from here anymore.`}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete remote host"
/>
