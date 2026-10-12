<script lang="ts">
	import { untrack } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import GitRepoPicker from "#lib/components/git-repo-picker.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { listRepoBranches } from "#lib/remote/git-repos.remote.js";
	import type { ConnectedGitProvider } from "#lib/server/git-connections.js";
	import {
		DEFAULT_WORKSTATION_HOME,
		DEFAULT_WORKSTATION_IMAGE,
		DEFAULT_WORKSTATION_PORT,
	} from "#lib/workstations.js";

	interface WorkstationValues {
		cpuLimit: number | null;
		env: Record<string, string>;
		gitBranch: string | null;
		gitUrl: string | null;
		homePath: string;
		image: string;
		memoryLimitMb: number | null;
		port: number;
	}

	const {
		providers = [],
		values,
	}: { providers?: ConnectedGitProvider[]; values: WorkstationValues } =
		$props();

	let manualUrl = $state(
		untrack(() => providers.length === 0 || !!values.gitUrl),
	);
	let gitUrl = $state(untrack(() => values.gitUrl ?? ""));
	let gitBranch = $state(untrack(() => values.gitBranch ?? ""));
	let pickedProviderId = $state("");
	let pickedRepo = $state("");
	let pickerResets = $state(0);

	const branchesPromise = $derived(
		!manualUrl && pickedProviderId && pickedRepo
			? listRepoBranches({ providerId: pickedProviderId, repo: pickedRepo })
			: null,
	);

	function useManualUrl() {
		manualUrl = true;
		pickedProviderId = "";
		pickedRepo = "";
	}

	function usePicker() {
		manualUrl = false;
		gitUrl = "";
		gitBranch = "";
	}

	function clearPick() {
		pickedProviderId = "";
		pickedRepo = "";
		gitUrl = "";
		gitBranch = "";
		pickerResets += 1;
	}

	const envText = $derived(
		Object.entries(values.env)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
	);
</script>

<section class="panel space-y-4 rounded-md p-5">
  <h2 class="eyebrow">Repository</h2>
  {#if manualUrl}
    <div class="grid gap-3 sm:grid-cols-[1fr_14rem]">
      <div>
        <label class={labelClass} for="gitUrl">Clone URL (optional)</label>
        <Input
          id="gitUrl"
          name="gitUrl"
          placeholder="https://github.com/you/app.git"
          type="url"
          bind:value={gitUrl}
        />
      </div>
      <div>
        <label class={labelClass} for="gitBranch">Branch (optional)</label>
        <Input
          id="gitBranch"
          name="gitBranch"
          placeholder="default branch"
          type="text"
          bind:value={gitBranch}
        />
      </div>
    </div>
    {#if providers.length > 0}
      <p class="text-text-subtle text-xs">
        <button
          class="text-accent font-medium hover:underline"
          onclick={usePicker}
          type="button"
        >
          Pick from a connected account instead
        </button>
      </p>
    {/if}
  {:else}
    <input name="gitUrl" type="hidden" value={gitUrl}>
    {#key pickerResets}
      <GitRepoPicker
        checkDockerfile={false}
        {labelClass}
        onpick={(repo, providerId) => {
          pickedProviderId = providerId;
          pickedRepo = repo.fullName;
          gitUrl = repo.cloneUrl;
          gitBranch = repo.defaultBranch;
        }}
        {providers}
      />
    {/key}
    {#if branchesPromise}
      <div class="sm:max-w-sm">
        <label class={labelClass} for="gitBranch">Branch</label>
        {#await branchesPromise}
          <p class="text-text-muted flex items-center gap-2 text-xs">
            <Spinner />
            Listing branches…
          </p>
          <input name="gitBranch" type="hidden" value={gitBranch}>
        {:then branches}
          <Select.Root name="gitBranch" type="single" bind:value={gitBranch}>
            <Select.Trigger class="w-full" id="gitBranch">{gitBranch}</Select.Trigger>
            <Select.Content>
              {#if !branches.includes(gitBranch)}
                <Select.Item label={gitBranch} value={gitBranch} />
              {/if}
              {#each branches as branch (branch)}
                <Select.Item label={branch} value={branch} />
              {/each}
            </Select.Content>
          </Select.Root>
        {:catch}
          <Input
            id="gitBranch"
            name="gitBranch"
            placeholder="default branch"
            type="text"
            bind:value={gitBranch}
          />
          <p class="mt-1.5 text-xs text-amber-600">
            Couldn't list branches, type the branch name instead.
          </p>
        {/await}
      </div>
    {:else}
      <input name="gitBranch" type="hidden" value={gitBranch}>
    {/if}
    <p class="text-text-subtle flex flex-wrap gap-x-3 text-xs">
      {#if pickedRepo}
        <button
          class="text-accent font-medium hover:underline"
          onclick={clearPick}
          type="button"
        >
          Don't clone a repository
        </button>
      {/if}
      <button
        class="text-accent font-medium hover:underline"
        onclick={useManualUrl}
        type="button"
      >
        Use a clone URL instead
      </button>
    </p>
  {/if}
  <p class="text-text-subtle text-xs">
    Cloned into the home directory the first time the workstation starts, with
    your git provider connection when the host matches one. Never re-cloned
    once it's there.
  </p>
</section>

<section class="panel space-y-4 rounded-md p-5">
  <h2 class="eyebrow">Container</h2>
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <label class={labelClass} for="image">Image</label>
      <Input
        id="image"
        name="image"
        placeholder={DEFAULT_WORKSTATION_IMAGE}
        type="text"
        value={values.image}
      />
      <p class="text-text-subtle mt-1.5 text-xs">
        Any image serving a web IDE over HTTP. Homerun sets <code>PASSWORD</code>,
        which code-server uses for its login.
      </p>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class={labelClass} for="port">IDE port</label>
        <Input
          id="port"
          max="65535"
          min="1"
          name="port"
          placeholder={String(DEFAULT_WORKSTATION_PORT)}
          type="number"
          value={values.port}
        />
      </div>
      <div>
        <label class={labelClass} for="homePath">Home path</label>
        <Input
          id="homePath"
          name="homePath"
          placeholder={DEFAULT_WORKSTATION_HOME}
          type="text"
          value={values.homePath}
        />
      </div>
    </div>
    <div>
      <label class={labelClass} for="cpuLimit">CPU limit (cores, optional)</label>
      <Input
        id="cpuLimit"
        min="0.1"
        name="cpuLimit"
        placeholder="unlimited"
        step="0.1"
        type="number"
        value={values.cpuLimit ?? ""}
      />
    </div>
    <div>
      <label class={labelClass} for="memoryLimitMb">Memory limit (MB, optional)</label>
      <Input
        id="memoryLimitMb"
        min="128"
        name="memoryLimitMb"
        placeholder="unlimited"
        step="1"
        type="number"
        value={values.memoryLimitMb ?? ""}
      />
    </div>
  </div>
  <div>
    <label class={labelClass} for="env">Environment variables (optional)</label>
    <Textarea
      class="font-mono text-xs"
      content={envText}
      id="env"
      name="env"
      placeholder={"KEY=value\nOTHER=value"}
      rows={4}
    />
  </div>
</section>
