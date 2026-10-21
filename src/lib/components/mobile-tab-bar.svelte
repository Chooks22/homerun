<script lang="ts">
	import { Bell, History, LayoutDashboard, Menu, Server } from "@lucide/svelte";
	import type { Component } from "svelte";
	import { mayVisit, type Permissions } from "#lib/permissions.js";
	import { getUnreadNotifications } from "#lib/remote/notifications.remote.js";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	let {
		menuButton = $bindable(null),
		menuOpen,
		onMenu,
		permissions,
	}: {
		menuButton?: HTMLElement | null;
		menuOpen: boolean;
		onMenu: () => void;
		permissions: Permissions;
	} = $props();

	interface BarItem {
		exact: boolean;
		href: string;
		icon: Component;
		label: string;
	}

	const unread = getUnreadNotifications();
	const unreadCount = $derived(unread.current?.unreadCount ?? 0);

	const items = $derived(
		(
			[
				{
					exact: true,
					href: resolve(""),
					icon: LayoutDashboard,
					label: "Home",
				},
				{
					exact: false,
					href: resolve("services"),
					icon: Server,
					label: "Services",
				},
				{
					exact: false,
					href: resolve("deployments"),
					icon: History,
					label: "Deploys",
				},
				{
					exact: false,
					href: resolve("notifications"),
					icon: Bell,
					label: "Alerts",
				},
			] satisfies BarItem[]
		).filter((item) => mayVisit(permissions, item.href)),
	);

	function isActive(item: BarItem): boolean {
		const path = page.url.pathname;
		return item.exact
			? path === item.href
			: path === item.href || path.startsWith(`${item.href}/`);
	}

	const itemClass =
		"group flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium outline-none transition-colors duration-150 focus-visible:text-text";
	const pillClass =
		"relative flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-200";
</script>

<nav
  class="panel-strong border-border flex shrink-0 items-stretch border-t px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"
  aria-label="Primary"
  data-slot="mobile-tab-bar"
>
  {#each items as item (item.href)}
    {@const active = isActive(item)}
    {@const Icon = item.icon}
    <a
      class="{itemClass} {active ? 'text-accent font-semibold' : 'text-text-muted'}"
      aria-current={active ? "page" : undefined}
      href={item.href}
    >
      <span class="{pillClass} {active ? 'bg-accent-light' : 'group-active:bg-surface-2'}">
        <Icon class="size-5" />
        {#if item.label === "Alerts" && unreadCount > 0}
          <span
            class="bg-ink text-ink-foreground absolute -top-0.5 right-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] leading-none font-bold"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        {/if}
      </span>
      {item.label}
    </a>
  {/each}
  <button
    class="{itemClass} {menuOpen ? 'text-accent font-semibold' : 'text-text-muted'}"
    aria-expanded={menuOpen}
    aria-label="Open menu"
    bind:this={menuButton}
    onclick={onMenu}
    type="button"
  >
    <span class="{pillClass} {menuOpen ? 'bg-accent-light' : 'group-active:bg-surface-2'}">
      <Menu class="size-5" />
    </span>
    Menu
  </button>
</nav>
