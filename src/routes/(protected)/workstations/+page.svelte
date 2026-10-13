<script lang="ts">
	import { LaptopMinimal, Layers, Play, Plus, Square } from "@lucide/svelte";
	import { onMount } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityList from "#lib/components/entity-list.svelte";
	import EntityToolbar, {
		type FilterGroup,
	} from "#lib/components/entity-toolbar.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import ViewModeToggle from "#lib/components/view-mode-toggle.svelte";
	import { BASE_SORTS } from "#lib/list-sorts.js";
	import { getWorkstationUsage } from "#lib/remote/stats.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Workstations"));

	const view = new ViewMode("workstations");

	const usageQuery = getWorkstationUsage();
	const usage = $derived(usageQuery.current ?? {});

	onMount(() => {
		const timer = setInterval(() => {
			void getWorkstationUsage().refresh();
		}, 30_000);
		return () => clearInterval(timer);
	});

	function megabytes(value: number): string {
		return value < 1024
			? `${value.toFixed(0)} MB`
			: `${(value / 1024).toFixed(1)} GB`;
	}

	const rows = $derived(
		data.workstations.map((ws) => ({
			error: ws.lastError,
			href: resolve("/(protected)/workstations/[workstationId]", {
				workstationId: ws.id,
			}),
			id: ws.id,
			running: ws.desiredState === "running",
			subtitle: [
				ws.image,
				ws.remoteHostId ? "remote host" : "this server",
				ws.gitUrl,
			]
				.filter(Boolean)
				.join(" · "),
			title: ws.name,
		})),
	);
	type Row = (typeof rows)[number];

	const filters: FilterGroup[] = [
		{
			key: "state",
			label: "State",
			options: [
				{ label: "Running", value: "running" },
				{ label: "Stopped", value: "stopped" },
			],
		},
	];
</script>

{#snippet media()}
  <div class="bg-accent/10 text-accent flex size-10 shrink-0 items-center justify-center rounded-md">
    <LaptopMinimal class="size-5" />
  </div>
{/snippet}

{#snippet badge(ws: Row)}
  {@const sample = ws.running ? usage[ws.id] : undefined}
  {#if sample}
    <span
      class="tech bg-surface-2 text-text-muted shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold"
      title="CPU and memory, sampled every minute"
    >
      {sample.cpuPercent.toFixed(0)}% · {megabytes(sample.memUsedMb)}{sample.memLimitMb
        ? ` / ${megabytes(sample.memLimitMb)}`
        : ""}
    </span>
  {/if}
  {#if ws.error}
    <span class="shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-[0.65rem] font-semibold text-red-600">
      Error
    </span>
  {:else if !ws.running}
    <span class="bg-surface-2 text-text-subtle shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold">
      Stopped
    </span>
  {/if}
{/snippet}

{#snippet actions(ws: Row)}
  <form
    action={ws.running ? "?/stop" : "?/start"}
    method="POST"
    use:enhance={enhanceToast({
      error: ws.running ? "Couldn't stop the workstation." : "Couldn't start the workstation.",
      loading: ws.running ? "Stopping the workstation" : "Starting the workstation",
      success: ws.running ? "Workstation stopped." : "Workstation starting.",
    })}
  >
    <input name="workstationId" type="hidden" value={ws.id} />
    <Button
      size="icon-sm"
      title={ws.running ? "Stop" : "Start"}
      type="submit"
      variant="ghost"
    >
      {#if ws.running}
        <Square class="size-4" />
      {:else}
        <Play class="size-4" />
      {/if}
    </Button>
  </form>
{/snippet}

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Workstations</h1>
      <p class="text-text-muted mt-1 text-sm">
        Your own dev boxes : a browser IDE with a persistent home, on this
        server or on an agent host. Only you see yours.
      </p>
    </div>

    <div class="flex items-center gap-2">
      <Button href={resolve("workstations/presets")} variant="outline"><Layers class="size-4" />Presets</Button>
      <Button href={resolve("workstations/new")}><Plus class="size-4" />New Workstation</Button>
    </div>
  </div>

  {#if data.total === 0 && !data.filtered}
    <EmptyState
      icon={LaptopMinimal}
      subtitle="Spin up VS Code in the browser, with your repository already cloned."
      title="No workstations yet"
    ><Button href={resolve("workstations/new")}><Plus class="size-4" />Create your first workstation</Button></EmptyState>
  {:else}
    <EntityToolbar
      sorts={BASE_SORTS}
      filters={filters}
      placeholder="Search workstations…"
    >
      {#snippet trailing()}
        <ViewModeToggle view={view} />
      {/snippet}
    </EntityToolbar>

    {#if data.workstations.length === 0}
      <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
        <p class="text-text-muted text-sm">No workstations match your search.</p>
      </div>
    {:else}
      <EntityList
        actions={actions}
        badge={badge}
        items={rows}
        media={media}
        view={view}
      />

      <Pagination
        label="workstations"
        page={data.page}
        perPage={data.perPage}
        total={data.total}
      />
    {/if}
  {/if}
</div>
