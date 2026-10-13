<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import { GIT_PROVIDER_KIND_LABELS } from "#lib/git-provider-kinds.js";
	import type { ConnectedGitProvider } from "#lib/server/git-connections.js";

	interface Props {
		providers?: ConnectedGitProvider[];
		trailing?: Snippet;
		values: {
			gitAuthorEmail: string | null;
			gitAuthorName: string | null;
			gitProviderId: string | null;
		};
	}

	const { providers = [], trailing, values }: Props = $props();

	let providerId = $state(untrack(() => values.gitProviderId ?? ""));

	const picked = $derived(providers.find((p) => p.id === providerId));

	function providerLabel(p: ConnectedGitProvider): string {
		return `${GIT_PROVIDER_KIND_LABELS[p.kind]} · ${p.name} (${p.providerUsername})`;
	}
</script>

<section class="panel rounded-xl">
  <PanelHeader
    description="Who commits from this workstation, and which connection pushes."
    title="Git"
    {trailing}
  />
  <div class="space-y-4 p-5">
    <div>
      <label class={labelClass} for="gitProviderId">Connection</label>
      <Select.Root name="gitProviderId" type="single" bind:value={providerId}>
        <Select.Trigger class="w-full" id="gitProviderId">
          {picked
            ? providerLabel(picked)
            : providerId
              ? "A provider that's no longer connected"
              : "None"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item label="None" value="" />
          {#each providers as p (p.id)}
            <Select.Item label={providerLabel(p)} value={p.id} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-text-subtle mt-1.5 text-xs">
        {#if providers.length === 0}
          Connect a git provider under Git Providers to push from here.
        {:else}
          Its token goes into git's credential store in the home directory on
          every start, and into <code>GH_TOKEN</code> or
          <code>GITLAB_TOKEN</code> for the provider's own CLI. Opening the IDE
          then signs you in through this provider instead of asking for the
          password.
        {/if}
      </p>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class={labelClass} for="gitAuthorName">Commit name (optional)</label>
        <Input
          id="gitAuthorName"
          name="gitAuthorName"
          placeholder={picked?.providerUsername ?? "Ada Lovelace"}
          type="text"
          value={values.gitAuthorName ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="gitAuthorEmail">Commit email (optional)</label>
        <Input
          id="gitAuthorEmail"
          name="gitAuthorEmail"
          placeholder="you@example.com"
          type="email"
          value={values.gitAuthorEmail ?? ""}
        />
      </div>
    </div>
  </div>
</section>
