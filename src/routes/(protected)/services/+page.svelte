<script lang="ts">
	import {
		Activity,
		CornerDownRight,
		FileUp,
		Layers,
		LayoutGridIcon,
		List,
		Network,
		Plus,
		Server,
	} from "@lucide/svelte";
	import { onMount, type Snippet } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import DeleteVolumesOption from "#lib/components/delete-volumes-option.svelte";
	import EntityList, {
		type EntityRow,
	} from "#lib/components/entity-list.svelte";
	import EntityToolbar, {
		type FilterGroup,
	} from "#lib/components/entity-toolbar.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import PreviewRows from "#lib/components/preview-rows.svelte";
	import SelectAllRow from "#lib/components/select-all-row.svelte";
	import ServiceContextMenu from "#lib/components/service-context-menu.svelte";
	import ServiceMenuHost from "#lib/components/service-menu-host.svelte";
	import ServiceTree from "#lib/components/service-tree.svelte";
	import StatusBadge from "#lib/components/status-badge.svelte";
	import TemplateIcon from "#lib/components/template-icon.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import ViewModeToggle from "#lib/components/view-mode-toggle.svelte";
	import { SERVICE_STATUS_CONFIG, UNGROUPED_LABEL } from "#lib/constants.js";
	import { ListSelection } from "#lib/list-selection.svelte.js";
	import { BASE_SORTS } from "#lib/list-sorts.js";
	import { syncServiceStatuses } from "#lib/remote/service-status.remote.js";
	import {
		SERVICE_ACTION_LABELS,
		type ServiceAction,
	} from "#lib/service-actions.js";
	import { primaryHostname } from "#lib/service-domains.js";
	import {
		dependencyForest,
		type GraphServiceInfo,
		previewsByParent,
	} from "#lib/service-graph.js";
	import { ancestorIds, flattenStackTree } from "#lib/stack-tree.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import type { ContainerStatus } from "#lib/types.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { resolve } from "$app/paths";
	import BulkBar from "./bulk-bar.svelte";
	import ServiceRowActions from "./service-row-actions.svelte";

	const { data } = $props();

	type Svc = (typeof data.services)[number];

	onMount(() => title.set("Services"));

	const view = new ViewMode("services");

	const selection = new ListSelection(() => data.services.map((svc) => svc.id));

	const filters = $derived<FilterGroup[]>([
		{
			icon: Activity,
			key: "status",
			label: "Status",
			options: data.facets.statuses.map((status) => ({
				label: SERVICE_STATUS_CONFIG[status as ContainerStatus].label,
				value: status,
			})),
		},
		{
			icon: Layers,
			key: "stack",
			label: "Stack",
			options: data.facets.stacks.map((name) => ({
				icon: Layers,
				label: name,
				value: name,
			})),
		},
	]);

	const groups = $derived.by(() => {
		const byStack = new Map<string | null, Svc[]>();
		for (const svc of data.services) {
			const key = svc.stackId ?? null;
			byStack.set(key, [...(byStack.get(key) ?? []), svc]);
		}
		const parents = new Map(data.stacks.map((s) => [s.id, s.parentId]));
		const shown = new Set(
			[...byStack.keys()]
				.filter((id): id is string => id !== null)
				.flatMap((id) => [id, ...ancestorIds(id, parents)]),
		);
		const rows = flattenStackTree(
			data.stacks.filter((s) => shown.has(s.id)),
		).map(({ depth, stack }) => ({
			depth,
			key: stack.id,
			label: stack.name,
			services: byStack.get(stack.id) ?? [],
		}));
		const ungrouped = byStack.get(null);
		return ungrouped
			? [
					...rows,
					{
						depth: 0,
						key: "ungrouped",
						label: UNGROUPED_LABEL,
						services: ungrouped,
					},
				]
			: rows;
	});

	const deployedIds = $derived(
		data.services
			.filter((svc) => svc.containerId || svc.swarmServiceId)
			.map((svc) => svc.id),
	);
	const synced = $derived(syncServiceStatuses(deployedIds));
	const liveStatus = $derived(
		new Map((synced.current ?? []).map((row) => [row.id, row.status])),
	);

	function statusOf(svc: Svc): ContainerStatus {
		return liveStatus.get(svc.id) ?? svc.currentStatus;
	}

	function byId(id: string): Svc | undefined {
		return data.services.find((svc) => svc.id === id);
	}

	// Tracks which service's action is in flight, keyed by serviceId, so
	// only that row's buttons show a spinner/disable.
	let pending = $state<Record<string, boolean>>({});

	function serviceName(serviceId: string): string {
		return (
			data.services.find((svc) => svc.id === serviceId)?.name ?? "the service"
		);
	}

	function withPending(serviceId: string, action: ServiceAction) {
		const label = SERVICE_ACTION_LABELS[action];
		return enhanceToast({
			error: `Couldn't ${label.verb} ${serviceName(serviceId)}.`,
			loading: `${label.progressive} ${serviceName(serviceId)}`,
			onSettled: () => {
				pending[serviceId] = false;
			},
			onStart: () => {
				pending[serviceId] = true;
			},
			success: `${serviceName(serviceId)} ${label.done}.`,
		});
	}

	let deleteDialogOpen = $state(false);
	let pendingDeleteName = $state("");
	let pendingDeleteForm: HTMLFormElement | null = null;
	let deleteVolumes = $state(false);

	function requestDelete(e: MouseEvent, name: string) {
		pendingDeleteForm = (e.currentTarget as HTMLElement).closest("form");
		pendingDeleteName = name;
		deleteVolumes = false;
		deleteDialogOpen = true;
	}

	let menuHost = $state<ReturnType<typeof ServiceMenuHost>>();

	const tree = $derived(
		data.tree && {
			forest: dependencyForest(
				data.tree.services.map((svc) => svc.id),
				new Map(Object.entries(data.tree.deps)),
			),
			previews: previewsByParent(data.tree.previews),
			services: new Map(data.tree.services.map((svc) => [svc.id, svc])),
		},
	);
</script>

<div class="p-5 md:p-6 {selection.count > 0 ? 'pb-28' : ''}">
  <div class="border-border mb-5 flex flex-wrap items-end justify-between gap-3 border-b pb-4">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Services</h1>
      <p class="text-text-muted mt-0.5 text-xs">
        Containers deployed to this server.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Button
        href={resolve('services/import')}
        size="sm"
        variant="outline"
      ><FileUp class="size-4" />Import compose</Button>

      <Button href={resolve('services/new')} size="sm"><Plus class="size-4" />Deploy a Service</Button>
    </div>
  </div>

  {#if data.total === 0 && !data.filtered}
    <div class="border-border flex flex-col items-center justify-center rounded-md border border-dashed py-20 text-center">
      <Server class="text-text-muted mb-3 size-10 opacity-40" />
      <p class="text-text-muted text-sm font-medium">No services yet</p>
      <p class="text-text-subtle mt-1 text-xs">Point at an image, fill in a config, and deploy.</p>

      <div
        class="flex flex-wrap items-center justify-center gap-2"
      >
        <Button
          class="mt-5"
          href={resolve('services/new')}
          size="sm"
        ><Plus class="size-4" />Deploy your first service</Button>

        <Button
          class="mt-5"
          href={resolve('templates')}
          size="sm"
          variant="outline"
        >
          <LayoutGridIcon class="size-4" />
          Start from a template
        </Button>
      </div>
    </div>
  {:else if tree}
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-text-subtle text-xs">
        Every service, with what it connects to underneath. Connections are read
        from env vars pointing at another service's slug.
      </p>
      <Button
        class="ml-auto"
        href={resolve('services')}
        size="sm"
        variant="outline"
      >
        <List class="size-4" />
        Back to the list
      </Button>
    </div>
    <ServiceTree
      nodes={tree.forest}
      previews={tree.previews}
      services={tree.services}
      stackNames={new Map()}
      wrapper={treeWrapper}
    />
  {:else}
    <EntityToolbar
      sorts={BASE_SORTS}
      filters={filters}
      placeholder="Search services by name, image or domain…"
    >
      {#snippet trailing()}
        <Button
          href="{resolve('services')}?view=tree"
          size="sm"
          variant="outline"
        ><Network class="size-4" />Dependencies</Button>

        <ViewModeToggle view={view} />
      {/snippet}
    </EntityToolbar>

    {#if data.services.length === 0}
      <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
        <p class="text-text-muted text-sm">No services match your filters.</p>
      </div>
    {:else}
      <SelectAllRow
        noun="services"
        selection={selection}
        visibleCount={data.services.length}
      />

      {#snippet wrapper(item: EntityRow, body: import("svelte").Snippet)}
        {@const svc = byId(item.id)}
        {#if svc}
          <ServiceContextMenu
            onaction={(op, id) => menuHost?.run(op, id)}
            ongroup={(s) => menuHost?.group(s)}
            onlink={(s) => menuHost?.link(s)}
            onungroup={(s) => menuHost?.ungroup(s)}
            service={svc}
          >
            {@render body()}
          </ServiceContextMenu>
        {:else}
          {@render body()}
        {/if}
      {/snippet}

      {#snippet media(item: { id: string })}
        {@const svc = byId(item.id)}
        <TemplateIcon
          category={svc?.category ?? null}
          class="size-8 rounded-lg"
          fallback={Server}
          icon={svc?.icon ?? null}
        />
        {#if svc}
          <span class="sr-only">{svc.name}</span>
        {/if}
      {/snippet}

      {#snippet badge(item: { id: string })}
        {@const svc = byId(item.id)}
        {#if svc}
          <StatusBadge status={statusOf(svc)} />
        {/if}
      {/snippet}

      {#snippet details(item: { id: string })}
        <PreviewRows class="ml-4 sm:ml-11" previews={byId(item.id)?.previews ?? []} />
      {/snippet}

      {#snippet actions(item: { id: string })}
        {@const svc = byId(item.id)}
        {#if svc}
          <ServiceRowActions
            deleteVolumes={deleteVolumes}
            ondelete={(e) => requestDelete(e, svc.name)}
            pending={pending[svc.id] ?? false}
            service={svc}
            submit={(action) => withPending(svc.id, action)}
          />
        {/if}
      {/snippet}

      <div class="space-y-6">
        {#each groups as { depth, key, label, services } (key)}
          <div
            class={depth > 0 ? "border-border border-l pl-4" : ""}
            style:margin-left="{depth * 1.25}rem"
          >
            {#if groups.length > 1}
              <h2 class="eyebrow mb-2 flex items-center gap-1.5">
                {#if depth > 0}
                  <CornerDownRight class="text-text-subtle size-3.5" />
                {/if}
                {label}
              </h2>
            {/if}
            {#if services.length > 0}
              <EntityList
                actions={actions}
                details={details}
                wrapper={wrapper}
                items={services.map((svc) => ({
                  description: `${svc.image}:${svc.tag}`,
                  href: `${resolve('services')}/${svc.id}`,
                  id: svc.id,
                subtitle:
                  primaryHostname(
                    svc,
                    data.stacks.find((stack) => stack.id === svc.stackId)?.slug,
                    data.serviceDomain,
                  ) ?? svc.slug,
                title: svc.name,
                }))}
                onToggleSelect={(id) => selection.toggle(id)}
                badge={badge}
                media={media}
                selectedIds={selection.ids}
                view={view}
              />
            {/if}
          </div>
        {/each}
      </div>

      <Pagination
        label="services"
        page={data.page}
        perPage={data.perPage}
        total={data.total}
      />
    {/if}
  {/if}
</div>

{#snippet treeWrapper(svc: GraphServiceInfo, body: Snippet)}
  <ServiceContextMenu
    onaction={(op, id) => menuHost?.run(op, id)}
    ongroup={(s) => menuHost?.group(s)}
    onlink={(s) => menuHost?.link(s)}
    onungroup={(s) => menuHost?.ungroup(s)}
    service={svc}
  >
    {@render body()}
  </ServiceContextMenu>
{/snippet}

<BulkBar selection={selection} />

<ConfirmDialog
  bind:open={deleteDialogOpen}
  confirmLabel="Delete"
  confirmPhrase={pendingDeleteName}
  description={`Delete "${pendingDeleteName}"? This removes its container and can't be undone.`}
  onConfirm={() => pendingDeleteForm?.requestSubmit()}
  title="Delete service"
>
  <DeleteVolumesOption bind:checked={deleteVolumes} />
</ConfirmDialog>

<ServiceMenuHost
  bind:this={menuHost}
  services={data.services}
  stacks={data.stacks}
/>
