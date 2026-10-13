<script lang="ts">
	import { Check } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationContainerFields from "#lib/components/workstation-container-fields.svelte";
	import WorkstationEditorFields from "#lib/components/workstation-editor-fields.svelte";
	import WorkstationGitFields from "#lib/components/workstation-git-fields.svelte";
	import WorkstationRepoFields from "#lib/components/workstation-repo-fields.svelte";
	import { slugify } from "#lib/slug.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import {
		DEFAULT_WORKSTATION_HOME,
		DEFAULT_WORKSTATION_IMAGE,
		DEFAULT_WORKSTATION_PORT,
		workstationHostname,
	} from "#lib/workstations.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();

	onMount(() => title.set("New Workstation"));

	let submitting = $state(false);
	let name = $state("");
	let remoteHostId = $state("");

	const hostname = $derived(
		workstationHostname(slugify(name) || "workstation", data.baseDomain),
	);
</script>

<div class="space-y-6 p-6 md:p-8">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">New Workstation</h1>
    <p class="text-text-muted mt-0.5 text-sm">
      A browser IDE in a container, with a home directory that survives
      restarts. It starts as soon as it's created.
    </p>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    action="?/create"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't create that workstation.",
      loading: "Creating the workstation",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Workstation created.",
    })}
  >
    <section class="panel space-y-4 rounded-md p-5">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class={labelClass} for="name">Name</label>
          <Input
            id="name"
            name="name"
            placeholder="my-app dev"
            required
            type="text"
            bind:value={name}
          />
          <p class="text-text-subtle mt-1.5 text-xs">
            Opens at <code>{hostname}</code>.
          </p>
        </div>
        <div>
          <label class={labelClass} for="remoteHostId">Runs on</label>
          <Select.Root name="remoteHostId" type="single" bind:value={remoteHostId}>
            <Select.Trigger class="w-full" id="remoteHostId">
              {data.agentHosts.find((host) => host.id === remoteHostId)?.name ??
                "This server"}
            </Select.Trigger>
            <Select.Content>
              <Select.Item label="This server" value="" />
              {#each data.agentHosts as host (host.id)}
                <Select.Item label={host.name} value={host.id} />
              {/each}
            </Select.Content>
          </Select.Root>
          <p class="text-text-subtle mt-1.5 text-xs">
            Any registered agent host works too. Its IDE port is published on
            that host and routed through this server's Traefik.
          </p>
        </div>
      </div>
    </section>

    <WorkstationRepoFields
      providers={data.gitProviders}
      values={{ gitBranch: null, gitUrl: null }}
    />

    <WorkstationEditorFields values={{ editorSettings: {}, extensions: [] }} />

    <WorkstationGitFields
      providers={data.gitProviders}
      values={{ gitAuthorEmail: null, gitAuthorName: null, gitProviderId: null }}
    />

    <WorkstationContainerFields
      values={{
        cpuLimit: null,
        env: {},
        homePath: DEFAULT_WORKSTATION_HOME,
        image: DEFAULT_WORKSTATION_IMAGE,
        memoryLimitMb: null,
        port: DEFAULT_WORKSTATION_PORT,
      }}
    />

    <Button disabled={submitting} type="submit">
      {#if submitting}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Create workstation
    </Button>
  </form>
</div>
