<script lang="ts">
	import { Check, Search } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Label } from "#lib/components/ui/label/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { GIT_PROVIDER_KIND_LABELS } from "#lib/git-provider-kinds.js";
	import { listProviderRepos } from "#lib/remote/git-repos.remote.js";
	import type { GitProviderKind } from "#lib/server/db/schema.js";
	import type { GitRepo } from "#lib/services/git-provider.service.js";

	interface ConnectedGitProvider {
		id: string;
		kind: GitProviderKind;
		name: string;
		providerUsername: string;
	}

	interface Props {
		labelClass: string;
		pending: boolean;
		providers: ConnectedGitProvider[];
		watched: string[];
	}

	const { labelClass, pending, providers, watched }: Props = $props();

	let providerId = $state(untrack(() => providers[0]?.id ?? ""));
	let filter = $state("");
	let selected = $state<string[]>([]);
	let reposPromise = $state<Promise<GitRepo[]> | null>(null);

	$effect(() => {
		const id = providerId;
		selected = [];
		reposPromise = id ? listProviderRepos(id) : null;
	});

	const watchedHere = $derived(
		new Set(
			watched
				.filter((key) => key.startsWith(`${providerId}:`))
				.map((key) => key.slice(providerId.length + 1)),
		),
	);

	function label(provider: ConnectedGitProvider): string {
		return `${GIT_PROVIDER_KIND_LABELS[provider.kind]} · ${provider.name} (${provider.providerUsername})`;
	}

	function matching(repos: GitRepo[]): GitRepo[] {
		const needle = filter.trim().toLowerCase();
		return needle
			? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
			: repos;
	}

	function toggle(fullName: string, checked: boolean) {
		selected = checked
			? [...selected, fullName]
			: selected.filter((name) => name !== fullName);
	}
</script>

<input name="providerId" type="hidden" value={providerId}>

<div class="space-y-3">
  {#if providers.length > 1}
    <div>
      <p class={labelClass}>Provider</p>
      <Select.Root type="single" bind:value={providerId}>
        <Select.Trigger class="w-full sm:w-auto">
          {label(providers.find((provider) => provider.id === providerId) ?? providers[0])}
        </Select.Trigger>
        <Select.Content>
          {#each providers as provider (provider.id)}
            <Select.Item label={label(provider)} value={provider.id} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}

  {#if reposPromise}
    {#await reposPromise}
      <p class="text-text-muted flex items-center gap-2 text-sm">
        <Spinner />
        Listing repositories…
      </p>
    {:then repos}
      {#if repos.length === 0}
        <p class="text-text-muted text-sm">No repositories on this connection.</p>
      {:else}
        <div class="relative">
          <Search class="text-text-subtle pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            class="pl-9"
            aria-label="Filter repositories"
            placeholder="Filter {repos.length} repositories…"
            type="search"
            bind:value={filter}
          />
        </div>
        <div class="grid max-h-112 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
          {#each matching(repos) as repo (repo.fullName)}
            {@const already = watchedHere.has(repo.fullName)}
            <Label
              class="has-aria-checked:border-accent has-aria-checked:bg-accent-light flex items-start gap-3 rounded-md border p-3 hover:bg-muted/50 {already
              ? 'opacity-60'
              : ''}"
            >
              <Checkbox
                checked={already || selected.includes(repo.fullName)}
                disabled={already}
                name="repos"
                onCheckedChange={(checked) => toggle(repo.fullName, checked)}
                value={JSON.stringify({ defaultBranch: repo.defaultBranch, fullName: repo.fullName })}
              />
              <span class="grid min-w-0 gap-1 font-normal">
                <span class="truncate text-sm leading-none font-medium">{repo.fullName}</span>
                <span class="text-text-subtle text-xs">
                  {already ? "Already watched" : repo.private ? "Private" : "Public"}
                </span>
              </span>
            </Label>
          {:else}
            <p class="text-text-muted text-sm">No repository matches.</p>
          {/each}
        </div>
      {/if}
    {:catch}
      <p class="text-sm text-amber-600">Couldn't list the repositories on that provider.</p>
    {/await}
  {/if}

  <Button disabled={pending || selected.length === 0} type="submit">
    {#if pending}
      <Spinner />
    {:else}
      <Check class="size-4" />
    {/if}
    {selected.length > 1 ? `Watch ${selected.length} repositories` : "Watch"}
  </Button>
</div>
