<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import GitRepoPicker from "#lib/components/git-repo-picker.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { listRepoBranches } from "#lib/remote/git-repos.remote.js";
	import type { ConnectedGitProvider } from "#lib/server/git-connections.js";

	interface Props {
		providers?: ConnectedGitProvider[];
		trailing?: Snippet;
		values: { gitBranch: string | null; gitUrl: string | null };
	}

	const { providers = [], trailing, values }: Props = $props();

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
</script>

<section class="panel rounded-xl">
  <PanelHeader
    description="Cloned into the home directory on the first start, never re-cloned once it's there."
    title="Repository"
    {trailing}
  />
  <div class="space-y-4 p-5">
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
      Cloned with your git provider connection when the host matches one.
    </p>
  </div>
</section>
