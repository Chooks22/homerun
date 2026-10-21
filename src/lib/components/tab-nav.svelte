<script lang="ts">
	import { ChevronLeft, ChevronRight } from "@lucide/svelte";
	import { type Component, type Snippet, untrack } from "svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import { useSubNav } from "#lib/sub-nav.svelte.js";
	import { page } from "$app/state";

	export interface NavTab {
		/** Rendered as a real link when set (route tabs); otherwise a button firing onSelect (in-page section tabs). */
		href?: string;
		icon?: Component;
		id: string;
		label: string;
		/** Small amber dot next to the label : a field on this tab needs attention (e.g. Settings' setup-issue highlight) even while it's not the active tab. */
		hasWarning?: boolean;
		/** One-line summary under the label on the mobile nav-card hub, from data the layout already loads. */
		description?: string;
	}

	const {
		active,
		children,
		onSelect,
		tabs,
	}: {
		active: string;
		children?: Snippet;
		onSelect?: (id: string) => void;
		tabs: NavTab[];
	} = $props();

	const subNav = useSubNav();
	const owner = {};
	const beside = $derived(
		subNav !== undefined && page.data.preferences?.tabLayout === "vertical",
	);

	if (subNav && untrack(() => beside)) {
		subNav.current = untrack(() => ({ active, onSelect, owner, tabs }));
	}

	$effect.pre(() => {
		if (!subNav) {
			return;
		}
		if (beside) {
			subNav.current = { active, onSelect, owner, tabs };
		} else if (subNav.current?.owner === owner) {
			subNav.current = null;
		}
		return () => {
			if (subNav.current?.owner === owner) {
				subNav.current = null;
			}
		};
	});

	const routed = $derived(
		tabs.length > 1 && tabs.every((tab) => tab.href !== undefined),
	);
	const hubHref = $derived(tabs[0]?.href?.split(/[?#]/)[0] ?? "");
	const atHub = $derived(
		routed && page.url.pathname === hubHref && page.url.search === "",
	);
	const activeTab = $derived(tabs.find((tab) => tab.id === active));

	/** The hub card's link: the first tab shares the hub's path, so it opens with a query string that tells the two apart. */
	function cardHref(tab: NavTab, index: number): string {
		return index === 0 ? `${hubHref}?view=tab` : (tab.href ?? "");
	}

	let strip = $state<HTMLDivElement>();

	$effect(() => {
		const current =
			active && strip?.querySelector<HTMLElement>("[data-active]");
		if (
			strip &&
			current &&
			(current.offsetLeft < strip.scrollLeft ||
				current.offsetLeft + current.offsetWidth >
					strip.scrollLeft + strip.clientWidth)
		) {
			strip.scrollLeft =
				current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
		}
	});

	function tabClass(isActive: boolean): string {
		return `group flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
			isActive
				? "bg-surface text-text shadow-sm ring-1 ring-border"
				: "text-text-muted hover:bg-surface/60 hover:text-text"
		}`;
	}
</script>

{#snippet content(tab: NavTab, isActive: boolean)}
  {@const TabIcon = tab.icon}
  {#if TabIcon}
    <TabIcon
      class="size-3.5 shrink-0 transition-colors {isActive ? 'text-accent' : 'text-text-subtle group-hover:text-accent'}"
    />
  {/if}
  {tab.label}
  {#if tab.hasWarning}
    <span class="size-1.5 shrink-0 rounded-full bg-amber-400" title="Needs attention"></span>
  {/if}
{/snippet}

<div
  bind:this={strip}
  class="mb-5 overflow-x-auto {routed ? 'max-md:hidden' : ''} {beside ? 'md:hidden' : ''}"
  data-slot="tab-nav"
>
  <div class="bg-surface-2 inline-flex min-w-max gap-1 rounded-lg p-1">
    {#each tabs as tab (tab.id)}
      {@const isActive = tab.id === active}
      {#if tab.href}
        <a
          class={tabClass(isActive)}
          aria-current={isActive ? "page" : undefined}
          data-active={isActive || undefined}
          href={tab.href}
        >
          {@render content(tab, isActive)}
        </a>
      {:else}
        <button
          class={tabClass(isActive)}
          data-active={isActive || undefined}
          onclick={() => onSelect?.(tab.id)}
          type="button"
        >
          {@render content(tab, isActive)}
        </button>
      {/if}
    {/each}
  </div>
</div>

{#if atHub}
  <nav class="grid grid-cols-2 gap-2.5 md:hidden" aria-label="Sections" data-slot="tab-hub">
    {#each tabs as tab, index (tab.id)}
      {@const TabIcon = tab.icon}
      <a
        class="border-border bg-surface active:bg-surface-2 relative flex min-h-24 flex-col justify-between gap-3 rounded-2xl border p-3.5 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 {tabs.length % 2 === 1 && index === tabs.length - 1 ? 'col-span-2' : ''}"
        href={cardHref(tab, index)}
      >
        <span class="bg-accent-light text-accent flex size-9 items-center justify-center rounded-xl">
          {#if TabIcon}<TabIcon class="size-4.5" />{:else}<ChevronRight class="size-4.5" />{/if}
        </span>
        <span class="flex flex-col gap-0.5">
          <span class="text-text text-sm leading-snug font-semibold">{tab.label}</span>
          {#if tab.description}
            <span class="text-xs {tab.hasWarning ? 'text-amber-600 dark:text-amber-400' : 'text-text-subtle'}">{tab.description}</span>
          {/if}
        </span>
        {#if tab.hasWarning}
          <span class="absolute top-3.5 right-3.5 size-2 rounded-full bg-amber-400" title="Needs attention"></span>
        {/if}
      </a>
    {/each}
  </nav>
{:else if routed}
  <div class="-mt-1 mb-4 flex items-center gap-2 md:hidden" data-slot="tab-back">
    <a
      class="text-accent -ml-2 flex min-h-11 items-center gap-0.5 rounded-lg pr-2 pl-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      href={hubHref}
    >
      <ChevronLeft class="size-5" />
      Sections
    </a>
    {#if activeTab}
      <span class="text-text-subtle" aria-hidden="true">/</span>
      <span class="text-text truncate text-sm font-semibold">{activeTab.label}</span>
    {/if}
  </div>
{/if}

{#if children}
  <div class={atHub ? "max-md:hidden" : "contents"}>
    <ErrorBoundary title="This tab hit an error while rendering.">
      {@render children()}
    </ErrorBoundary>
  </div>
{/if}
