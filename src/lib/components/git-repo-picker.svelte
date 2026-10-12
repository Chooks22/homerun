<script lang="ts">
	import { Check, ChevronsUpDown, GitBranch } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import * as Command from "#lib/components/ui/command/index.js";
	import * as Popover from "#lib/components/ui/popover/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { GIT_PROVIDER_KIND_LABELS } from "#lib/git-provider-kinds.js";
	import {
		hasDockerfile,
		listProviderRepos,
	} from "#lib/remote/git-repos.remote.js";
	import type { GitProviderKind } from "#lib/server/db/schema.js";
	import type { GitRepo } from "#lib/services/git-provider.service.js";

	interface ConnectedProvider {
		id: string;
		kind: GitProviderKind;
		name: string;
		providerUsername: string;
	}

	const {
		checkDockerfile = true,
		initialProviderId = null,
		initialRepo = null,
		labelClass,
		onpick,
		providers,
	}: {
		checkDockerfile?: boolean;
		initialProviderId?: string | null;
		initialRepo?: string | null;
		labelClass: string;
		onpick: (repo: GitRepo, providerId: string) => void;
		providers: ConnectedProvider[];
	} = $props();

	let providerId = $state(
		untrack(
			() =>
				providers.find((p) => p.id === initialProviderId)?.id ??
				providers[0]?.id ??
				"",
		),
	);
	let reposPromise = $state<Promise<GitRepo[]> | null>(null);
	const providerLabel = $derived.by(() => {
		const current = providers.find((p) => p.id === providerId);
		return current ? providerOptionLabel(current) : "";
	});

	function providerOptionLabel(p: ConnectedProvider): string {
		return `${GIT_PROVIDER_KIND_LABELS[p.kind]} · ${p.name} (${p.providerUsername})`;
	}
	let selectedRepo = $state(
		untrack(() =>
			providerId === initialProviderId ? (initialRepo ?? "") : "",
		),
	);
	let dockerfilePromise = $state<Promise<boolean> | null>(null);
	let open = $state(false);

	// Listing starts as soon as a provider is selected (and on mount, for the
	// usual single-connection case) rather than behind a "List repos" button :
	// picking the repo is the whole point of connecting one.
	$effect(() => {
		const id = providerId;
		if (id !== untrack(() => initialProviderId)) {
			selectedRepo = "";
		}
		dockerfilePromise = null;
		reposPromise = id ? listProviderRepos(id) : null;
	});

	function pickRepo(repos: GitRepo[], fullName: string) {
		selectedRepo = fullName;
		open = false;
		dockerfilePromise = null;
		const repo = repos.find((r) => r.fullName === fullName);
		if (!repo) {
			return;
		}
		onpick(repo, providerId);
		if (!checkDockerfile) {
			return;
		}
		dockerfilePromise = hasDockerfile({
			providerId,
			ref: repo.defaultBranch,
			repo: fullName,
		});
	}
</script>

<div class="border-border rounded-md border p-4">
  <p class={labelClass}>Browse repos</p>
  <div class="flex flex-wrap gap-2">
    {#if providers.length > 1}
      <Select.Root type="single" bind:value={providerId}>
        <Select.Trigger>{providerLabel}</Select.Trigger>
        <Select.Content>
          {#each providers as p (p.id)}
            <Select.Item label={providerOptionLabel(p)} value={p.id} />
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  </div>

  {#if reposPromise}
    {#await reposPromise}
      <p class="text-text-muted mt-3 flex items-center gap-2 text-xs">
        <Spinner />
        Listing repos…
      </p>
    {:then repos}
      {#if repos.length === 0}
        <p class="text-text-muted mt-3 text-xs">
          No repositories on this connection.
        </p>
      {:else}
        <Popover.Root bind:open>
          <Popover.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                class="mt-3 w-full justify-between"
                role="combobox"
                type="button"
                variant="outline"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <GitBranch class="size-4 shrink-0" />
                  <span class="truncate">
                    {selectedRepo || `Search ${repos.length} repos…`}
                  </span>
                </span>
                <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
              </Button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content class="w-(--bits-popover-anchor-width) p-0">
            <Command.Root>
              <Command.Input placeholder="Filter repos…" />
              <Command.List>
                <Command.Empty>No repo matches.</Command.Empty>
                <Command.Group>
                  {#each repos as repo (repo.fullName)}
                    <Command.Item
                      onSelect={() => pickRepo(repos, repo.fullName)}
                      value={repo.fullName}
                    >
                      <Check
                        class="size-4 {selectedRepo === repo.fullName
                        ? ''
                        : 'opacity-0'}"
                      />
                      <span class="truncate">{repo.fullName}</span>
                      {#if repo.private}
                        <span class="text-text-subtle ml-auto text-[0.6875rem]">
                          private
                        </span>
                      {/if}
                    </Command.Item>
                  {/each}
                </Command.Group>
              </Command.List>
            </Command.Root>
          </Popover.Content>
        </Popover.Root>
      {/if}
    {:catch}
      <p class="mt-3 text-xs text-amber-600">
        Couldn't list repos for that provider.
      </p>
    {/await}
  {/if}

  {#if dockerfilePromise}
    {#await dockerfilePromise then exists}
      <p class="mt-2 text-xs {exists ? 'text-emerald-600' : 'text-amber-600'}">
        {
          exists
          ? "✓ Dockerfile found at the repo root."
          : "⚠ No Dockerfile found at the repo root on this branch : set its path below, or pick Nixpacks, Railpack or buildpacks as the build method."
        }
      </p>
    {:catch}
      <p class="text-text-muted mt-2 text-xs">
        Couldn't check for a Dockerfile on this branch.
      </p>
    {/await}
  {/if}
</div>
