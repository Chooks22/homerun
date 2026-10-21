<script lang="ts">
	import { ChevronRight, Plus } from "@lucide/svelte";
	import { modeStorageKey, setMode } from "mode-watcher";
	import { type Component, onMount, tick } from "svelte";
	import { MediaQuery } from "svelte/reactivity";
	import { slide } from "svelte/transition";
	import AppVersion from "#lib/components/app-version.svelte";
	import BrandMark from "#lib/components/brand-mark.svelte";
	import Breadcrumbs from "#lib/components/breadcrumbs.svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import GlobalSearch from "#lib/components/global-search.svelte";
	import MobileDrawer from "#lib/components/mobile-drawer.svelte";
	import MobileTabBar from "#lib/components/mobile-tab-bar.svelte";
	import NotificationBell from "#lib/components/notification-bell.svelte";
	import ProfileMenu from "#lib/components/profile-menu.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { appearanceCss } from "#lib/palettes.js";
	import { can, mayVisit } from "#lib/permissions.js";
	import { provideSubNav } from "#lib/sub-nav.svelte.js";
	import { DEFAULT_SURFACE, effectiveSurface } from "#lib/surfaces.js";
	import { visibleItems } from "#lib/ui-mode.js";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";
	import { allNavItems, NAV_PARENT_ICONS, type NavItem } from "./nav-items";

	const { data, children } = $props();

	const subNav = provideSubNav();
	const sectionTabs = $derived.by(() => {
		const entry = subNav.current;
		const path = page.url.pathname;
		return entry?.tabs.some(
			(tab) =>
				tab.href !== undefined &&
				(path === tab.href || path.startsWith(`${tab.href}/`)),
		)
			? entry
			: null;
	});

	let sidebarOpen = $state(false);
	let sidebarToggle = $state<HTMLElement | null>(null);
	let sidebarClose = $state<HTMLElement | null>(null);
	const desktop = new MediaQuery("(min-width: 768px)");

	function closeSidebar() {
		sidebarOpen = false;
		void tick().then(() => sidebarToggle?.focus());
	}

	// Seeds a browser that's never set a device-local theme override (no
	// mode-watcher localStorage entry yet, e.g. a first visit on a new
	// device) from the account's own saved preference, so signing in
	// somewhere new picks up the theme chosen on /profile/appearance instead
	// of defaulting to "system". A browser that already has its own
	// mode-watcher entry (set by a past visit here, or by that page itself)
	// is left alone : mode-watcher's own localStorage persistence owns it
	// from that point on.
	onMount(() => {
		if (
			data.preferences.theme !== "system" &&
			!localStorage.getItem(modeStorageKey.current)
		) {
			setMode(data.preferences.theme);
		}
	});

	type NavEntry =
		| { item: NavItem; kind: "item" }
		| { icon: Component; items: NavItem[]; kind: "parent"; label: string };

	interface NavGroup {
		entries: NavEntry[];
		heading: string;
	}

	const accentCss = $derived(
		data.preferences.preset ? "" : appearanceCss(data.preferences),
	);

	$effect(() => {
		document.documentElement.dataset.surface = effectiveSurface(
			data.preferences,
		);
		return () => {
			document.documentElement.dataset.surface = DEFAULT_SURFACE;
		};
	});

	/** Groups a flat item list into category-labeled sections, nesting items that share a `parent` under one collapsible entry, preserving first-seen order. */
	function groupByCategory(items: NavItem[]): NavGroup[] {
		const groups: NavGroup[] = [];
		for (const item of items) {
			let group = groups.find((g) => g.heading === item.category);
			if (!group) {
				group = { entries: [], heading: item.category };
				groups.push(group);
			}
			if (!item.parent) {
				group.entries.push({ item, kind: "item" });
				continue;
			}
			const parent = group.entries.find(
				(entry) => entry.kind === "parent" && entry.label === item.parent,
			);
			if (parent?.kind === "parent") {
				parent.items.push(item);
			} else {
				group.entries.push({
					icon: NAV_PARENT_ICONS[item.parent] ?? item.icon,
					items: [item],
					kind: "parent",
					label: item.parent,
				});
			}
		}
		return groups;
	}

	const navItemGroups = $derived(
		groupByCategory(
			visibleItems(
				data.uiMode,
				allNavItems
					.filter((item) => mayVisit(data.permissions, item.href))
					.map((item) => ({ ...item, id: item.href })),
				page.url.pathname,
			),
		),
	);

	function isActive(href: string, exact: boolean): boolean {
		if (exact) {
			return page.url.pathname === href;
		}
		return page.url.pathname.startsWith(href);
	}

	const NAV_OPEN_KEY = "homerun-nav-open";
	let openChoices = $state<Record<string, boolean>>({});

	onMount(() => {
		try {
			openChoices = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) ?? "{}");
		} catch {
			openChoices = {};
		}
	});

	function hasActive(items: NavItem[]): boolean {
		return items.some((item) => isActive(item.href, item.exact));
	}

	function parentOpen(label: string, items: NavItem[]): boolean {
		return hasActive(items) || (openChoices[label] ?? false);
	}

	function toggleParent(label: string, items: NavItem[]) {
		openChoices = { ...openChoices, [label]: !parentOpen(label, items) };
		try {
			localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(openChoices));
		} catch {
			return;
		}
	}
</script>

{#snippet navLink(item: NavItem, onNavigate?: () => void)}
  {@const active = isActive(item.href, item.exact)}
  {@const NavIcon = item.icon}
  <a
    class="
      group/nav relative mb-0.5 flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-[0.8125rem] transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50
      {active
      ? 'border-sidebar-border bg-sidebar-accent text-accent font-semibold'
      : 'text-text-muted hover:bg-surface-2 hover:text-text border-transparent font-medium'}
   "
    aria-current={active ? "page" : undefined}
    href={item.href}
    onclick={onNavigate}
  >
    <NavIcon class="text-accent size-4 shrink-0" />
    {(item.parent && item.navLabel) || item.label}
  </a>
{/snippet}

{#snippet navGroups(groups: NavGroup[], onNavigate?: () => void)}
  {#each groups as group (group.heading)}
    <p class="text-text-subtle mt-5 mb-1.5 px-2.5 text-xs font-medium">
      {group.heading}
    </p>
    {#each group.entries as entry (entry.kind === "item" ? entry.item.href : entry.label)}
      {#if entry.kind === "item"}
        {@render navLink(entry.item, onNavigate)}
      {:else}
        {@const open = parentOpen(entry.label, entry.items)}
        {@const ParentIcon = entry.icon}
        <button
          class="
            mb-0.5 flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left text-[0.8125rem] font-medium transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50
            {hasActive(entry.items) ? 'text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'}
          "
          aria-expanded={open}
          onclick={() => toggleParent(entry.label, entry.items)}
          type="button"
        >
          <ParentIcon class="text-accent size-4 shrink-0" />
          <span class="flex-1">{entry.label}</span>
          <ChevronRight
            class="text-text-subtle size-3.5 transition-transform duration-150 {open ? 'rotate-90' : ''}"
          />
        </button>
        {#if open}
          <div class="border-border mb-1 ml-4.5 border-l pl-2" transition:slide={{ duration: 150 }}>
            {#each entry.items as item (item.href)}
              {@render navLink(item, onNavigate)}
            {/each}
          </div>
        {/if}
      {/if}
    {/each}
  {/each}
{/snippet}

<svelte:window
  onkeydown={(event) => {
    if (sidebarOpen && event.key === "Escape") {
      closeSidebar();
    }
  }}
/>

<svelte:head>
  {#if accentCss}
    {@html `<style>${accentCss}</style>`}
  {/if}
</svelte:head>

<!-- Fills the full viewport : there's no global navbar above this. -->
<div class="flex h-dvh overflow-hidden md:gap-2 md:p-2">
  <a
    class="bg-ink text-ink-foreground fixed top-4 left-4 z-60 rounded-md px-3 py-2 text-sm font-medium not-focus:sr-only"
    href="#main-content"
    onclick={(event) => {
      event.preventDefault();
      document.getElementById("main-content")?.focus();
    }}
  >
    Skip to content
  </a>
  <!-- ── Desktop sidebar ───────────────────────────────────────── -->
  <aside class="hidden w-64 shrink-0 flex-col md:order-1 md:flex" data-slot="app-sidebar">
    <BrandMark class="px-3 py-2.5" />

    {#if can(data.permissions, "services", "write")}
      <div class="px-2 pb-2">
        <Button class="w-full" href={resolve('services/new')}><Plus class="size-4" />Deploy a service</Button>
      </div>
    {/if}

    <!-- Nav links -->
    <nav class="flex-1 overflow-y-auto px-2 pb-3">
      {@render navGroups(navItemGroups)}
    </nav>
    <ErrorBoundary compact>
      <AppVersion admin={can(data.permissions, "settings", "write")} />
    </ErrorBoundary>
  </aside>

  <MobileDrawer bind:closeButton={sidebarClose} onClose={closeSidebar} open={sidebarOpen}>
    {#if can(data.permissions, "services", "write")}
      <Button class="mt-1 w-full" href={resolve('services/new')} onclick={() => (sidebarOpen = false)}><Plus class="size-4" />Deploy a service</Button>
    {/if}
    {@render navGroups(navItemGroups, () => {
      sidebarOpen = false;
    })}
    {#snippet footer()}
      <ErrorBoundary compact>
        <AppVersion admin={can(data.permissions, "settings", "write")} />
      </ErrorBoundary>
    {/snippet}
  </MobileDrawer>

  <!-- ── Main content ───────────────────────────────────────────── -->
  <div
    class="panel flex flex-1 flex-col overflow-hidden transition-[translate,scale,border-radius] duration-380 ease-snap max-md:border-0 md:order-3 md:rounded-xl {sidebarOpen ? 'max-md:translate-x-6 max-md:scale-[0.94] max-md:rounded-2xl' : ''}"
    data-slot="app-frame"
    inert={sidebarOpen && !desktop.current}
  >
    <!-- Sticky header, every page, both breakpoints : page title on the
         left, notifications + account menu on the right. -->
    <header
      class="border-border sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3 md:px-5"
      data-slot="app-header"
    >
      <Breadcrumbs roots={allNavItems} />
      {#if data.readOnly}
        <span
          class="text-text-muted border-border hidden rounded-full border px-2 py-0.5 text-[0.7rem] font-medium sm:inline"
          title="This account or API key can view but can't change anything."
        >
          Read-only
        </span>
      {/if}
      <ErrorBoundary compact>
        <GlobalSearch permissions={data.permissions} />
      </ErrorBoundary>
      <div class="hidden md:contents">
        <ErrorBoundary compact>
          <NotificationBell />
        </ErrorBoundary>
      </div>
      <ErrorBoundary compact>
        <ProfileMenu uiMode={data.uiMode} user={data.user} />
      </ErrorBoundary>
    </header>

    <!-- Page content -->
    <main class="relative flex-1 overflow-y-auto outline-none" id="main-content" tabindex="-1">
      <ErrorBoundary class="p-5 md:p-6">
        {@render children()}
      </ErrorBoundary>
    </main>
    <ErrorBoundary compact>
      <MobileTabBar
        bind:menuButton={sidebarToggle}
        menuOpen={sidebarOpen}
        onMenu={() => {
          sidebarOpen = true;
          void tick().then(() => sidebarClose?.focus());
        }}
        permissions={data.permissions}
      />
    </ErrorBoundary>
  </div>
  {#if sectionTabs}
    <aside
      class="hidden w-56 shrink-0 flex-col md:order-2 md:flex"
      aria-label="Sections"
      data-slot="app-sidebar"
    >
      <nav class="flex-1 overflow-y-auto px-2 pt-3 pb-3">
        {#each sectionTabs.tabs as tab (tab.id)}
          {@const active = tab.id === sectionTabs.active}
          {@const TabIcon = tab.icon}
          {@const itemClass = `group/nav relative mb-0.5 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${active ? "border-sidebar-border bg-sidebar-accent text-accent font-semibold" : "text-text-muted hover:bg-surface-2 hover:text-text border-transparent font-medium"}`}
          {#if tab.href}
            <a class={itemClass} aria-current={active ? "page" : undefined} href={tab.href}>
              {#if TabIcon}<TabIcon class="text-accent size-4 shrink-0" />{/if}
              <span class="truncate">{tab.label}</span>
              {#if tab.hasWarning}<span class="ml-auto size-1.5 shrink-0 rounded-full bg-amber-400" title="Needs attention"></span>{/if}
            </a>
          {:else}
            <button class={itemClass} onclick={() => sectionTabs.onSelect?.(tab.id)} type="button">
              {#if TabIcon}<TabIcon class="text-accent size-4 shrink-0" />{/if}
              <span class="truncate">{tab.label}</span>
              {#if tab.hasWarning}<span class="ml-auto size-1.5 shrink-0 rounded-full bg-amber-400" title="Needs attention"></span>{/if}
            </button>
          {/if}
        {/each}
      </nav>
    </aside>
  {/if}
</div>
