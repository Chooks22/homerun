<script lang="ts">
	import { Layers, Plus } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityList from "#lib/components/entity-list.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import ViewModeToggle from "#lib/components/view-mode-toggle.svelte";
	import { title } from "#lib/store/title.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Workstation Presets"));

	const view = new ViewMode("workstation-presets");

	const rows = $derived(
		data.presets.map((preset) => ({
			href: resolve("/(protected)/workstations/presets/[presetId]", {
				presetId: preset.id,
			}),
			id: preset.id,
			subtitle:
				preset.description ??
				[preset.image, preset.gitUrl].filter(Boolean).join(" · "),
			title: preset.name,
		})),
	);
</script>

{#snippet media()}
  <div class="bg-accent/10 text-accent flex size-10 shrink-0 items-center justify-center rounded-md">
    <Layers class="size-5" />
  </div>
{/snippet}

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Workstation Presets</h1>
      <p class="text-text-muted mt-1 text-sm">
        Saved settings to start a new workstation from. Only you see yours.
      </p>
    </div>

    <div class="flex items-center gap-2">
      {#if data.presets.length > 0}
        <ViewModeToggle view={view} />
      {/if}
      <Button href={resolve("workstations/presets/new")}><Plus class="size-4" />New Preset</Button>
    </div>
  </div>

  {#if data.presets.length === 0}
    <EmptyState
      icon={Layers}
      subtitle="Save a workstation's settings as a preset from its Settings tab, or make one here."
      title="No presets yet"
    ><Button href={resolve("workstations/presets/new")}><Plus class="size-4" />Create your first preset</Button></EmptyState>
  {:else}
    <EntityList items={rows} media={media} view={view} />
  {/if}
</div>
