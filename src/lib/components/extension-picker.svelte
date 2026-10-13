<script lang="ts">
	import { Check, Plus, Puzzle, X } from "@lucide/svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import * as Command from "#lib/components/ui/command/index.js";
	import * as Popover from "#lib/components/ui/popover/index.js";
	import { searchEditorExtensions } from "#lib/remote/workstations.remote.js";
	import type { EditorExtension } from "#lib/services/open-vsx.js";
	import { EXTENSION_ID_RE } from "#lib/workstations.js";

	interface Props {
		id: string;
		value: string[];
	}

	let { id, value = $bindable() }: Props = $props();

	const DEBOUNCE_MS = 250;

	let open = $state(false);
	let search = $state("");
	let resultsPromise = $state<Promise<EditorExtension[]> | null>(null);

	const term = $derived(search.trim());
	const typedId = $derived(
		EXTENSION_ID_RE.test(term) && !value.includes(term.toLowerCase())
			? term.toLowerCase()
			: null,
	);

	$effect(() => {
		const q = term;
		if (q.length < 2) {
			resultsPromise = null;
			return;
		}
		const timer = setTimeout(() => {
			resultsPromise = searchEditorExtensions(q.slice(0, 100));
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	function toggle(extId: string) {
		value = value.includes(extId)
			? value.filter((item) => item !== extId)
			: [...value, extId];
	}

	function remove(extId: string) {
		value = value.filter((item) => item !== extId);
	}

	function formatDownloads(count: number): string {
		return Intl.NumberFormat("en", { notation: "compact" }).format(count);
	}
</script>

{#each value as extId (extId)}
  <input name="extensions" type="hidden" value={extId}>
{/each}

<div class="space-y-2">
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          class="w-full justify-between"
          {id}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span class="text-text-muted flex min-w-0 items-center gap-2">
            <Puzzle class="size-4 shrink-0" />
            <span class="truncate">Search Open VSX…</span>
          </span>
          <Plus class="size-4 shrink-0 opacity-50" />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-(--bits-popover-anchor-width) p-0">
      <Command.Root shouldFilter={false}>
        <Command.Input
          placeholder="prettier, golang.go, rust-analyzer…"
          bind:value={search}
        />
        <Command.List class="max-h-80">
          {#if typedId}
            <Command.Group heading="Exact id">
              <Command.Item onSelect={() => toggle(typedId)} value="typed:{typedId}">
                <Plus class="size-4 shrink-0" />
                <span class="truncate font-mono text-xs">{typedId}</span>
              </Command.Item>
            </Command.Group>
          {/if}
          {#if resultsPromise}
            {#await resultsPromise}
              <Command.Loading>
                <p class="text-text-muted px-2 py-3 text-xs">Searching…</p>
              </Command.Loading>
            {:then results}
              {#if results.length === 0}
                <p class="text-text-muted px-2 py-6 text-center text-sm">
                  Nothing on Open VSX matches “{term}”.
                </p>
              {:else}
                <Command.Group heading="Open VSX">
                  {#each results as ext (ext.id)}
                    <Command.Item onSelect={() => toggle(ext.id)} value={ext.id}>
                      <Check
                        class="size-4 shrink-0 {value.includes(ext.id) ? '' : 'opacity-0'}"
                      />
                      {#if ext.icon}
                        <img
                          class="size-6 shrink-0 rounded-sm object-contain"
                          alt=""
                          loading="lazy"
                          src={ext.icon}
                        >
                      {:else}
                        <Puzzle class="text-text-muted size-6 shrink-0" />
                      {/if}
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate">{ext.displayName}</span>
                        <span class="text-text-subtle truncate text-[0.6875rem]">
                          {ext.id} · {formatDownloads(ext.downloads)} installs
                        </span>
                      </span>
                    </Command.Item>
                  {/each}
                </Command.Group>
              {/if}
            {:catch}
              <p class="px-2 py-3 text-xs text-red-600 dark:text-red-400">
                Couldn't reach Open VSX. Type an exact publisher.name id instead.
              </p>
            {/await}
          {:else if !typedId}
            <p class="text-text-muted px-2 py-6 text-center text-sm">
              Type to search, or paste a publisher.name id.
            </p>
          {/if}
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Root>

  {#if value.length > 0}
    <ul class="flex flex-wrap gap-1.5">
      {#each value as extId (extId)}
        <li class="border-border bg-surface-2 flex items-center gap-1 rounded-md border py-0.5 pr-1 pl-2 font-mono text-xs">
          {extId}
          <button
            class="text-text-muted hover:text-text rounded-sm p-0.5"
            aria-label="Remove {extId}"
            onclick={() => remove(extId)}
            type="button"
          >
            <X class="size-3" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
