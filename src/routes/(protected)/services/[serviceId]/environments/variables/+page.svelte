<script lang="ts">
	import { FileText, SlidersHorizontal } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EnvVarsEditor from "#lib/components/env-vars-editor.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const svc = $derived(data.service);

	onMount(() => title.set(`${svc.name} · Environment Variables`));

	let submitting = $state(false);
	let savingEnvFiles = $state(false);
</script>

<div class="space-y-6">
<section class="rounded-md panel">
  <PanelHeader
    description="Changes take effect on the next deploy : hit Redeploy on Overview after saving. The lock marks a value secret: it's hidden here and always redacted for AI agents, whatever its name."
    icon={SlidersHorizontal}
    title="Environment variables"
  >
    {#snippet trailing()}
      <SaveButton form="env-vars" pending={submitting} />
    {/snippet}
  </PanelHeader>

  <form
    id="env-vars"
    action="?/update"
    class="space-y-2.5 p-5"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't save.",
      loading: "Saving environment variables",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Saved.",
    })}
  >
    <EnvVarsEditor envVars={svc.envVars ?? {}} secretEnvKeys={svc.secretEnvKeys} />
  </form>
</section>

<section class="panel rounded-md">
  <PanelHeader icon={FileText} title="Env files">
    {#snippet description()}
      <code>.env</code> files on this host, read at every deploy. Variables
      above win over a file's, and a later file wins over an earlier one. A
      file that can't be read fails the deploy.
    {/snippet}
    {#snippet trailing()}
      {#if data.hostAccess}
        <SaveButton form="env-files" pending={savingEnvFiles} />
      {/if}
    {/snippet}
  </PanelHeader>

  {#if !data.hostAccess}
    <div class="space-y-2 p-5 text-xs">
      {#if (svc.envFiles ?? []).length > 0}
        <ul class="text-text font-mono">
          {#each svc.envFiles ?? [] as path (path)}
            <li>{path}</li>
          {/each}
        </ul>
      {:else}
        <p class="text-text-muted">No env files.</p>
      {/if}
      <p class="text-text-subtle">
        Changing env files needs write access to System : they're read from the host.
      </p>
    </div>
  {:else}
  <form
    id="env-files"
    action="?/updateEnvFiles"
    class="space-y-3 p-5"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't save the env files.",
      loading: "Saving env files",
      onSettled: () => {
        savingEnvFiles = false;
      },
      onStart: () => {
        savingEnvFiles = true;
      },
      success: "Saved.",
    })}
  >
    <Textarea
      class="min-h-20 font-mono text-xs"
      aria-label="Env file paths"
      name="envFiles"
      placeholder="/opt/my-app/.env"
      value={(svc.envFiles ?? []).join("\n")}
    />
    <p class="text-text-subtle text-xs">One absolute path per line.</p>
    {#if form?.envFilesError}
      <p class="text-xs text-red-500">{form.envFilesError}</p>
    {/if}
  </form>
  {/if}
</section>
</div>
