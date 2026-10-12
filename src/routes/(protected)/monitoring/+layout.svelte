<script lang="ts">
	import {
		Activity,
		BarChart3,
		Settings2,
		ShieldBan,
		ShieldCheck,
	} from "@lucide/svelte";
	import TabNav from "#lib/components/tab-nav.svelte";
	import { can } from "#lib/permissions.js";
	import { currentHref, visibleItems } from "#lib/ui-mode.js";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { children, data } = $props();

	const tabs = $derived([
		{
			href: resolve("/(protected)/monitoring"),
			icon: BarChart3,
			id: "monitoring",
			label: "Overview",
		},
		{
			href: resolve("/(protected)/monitoring/traces"),
			icon: Activity,
			id: "monitoring/traces",
			label: "Traces",
		},
		...(can(data.permissions, "settings", "read")
			? [
					{
						href: resolve("/(protected)/monitoring/blocked"),
						icon: ShieldBan,
						id: "monitoring/blocked",
						label: "Blocked IPs",
					},
					{
						href: resolve("/(protected)/monitoring/crowdsec"),
						icon: ShieldCheck,
						id: "monitoring/crowdsec",
						label: "CrowdSec",
					},
					{
						href: resolve("/(protected)/monitoring/settings"),
						icon: Settings2,
						id: "monitoring/settings",
						label: "Settings",
					},
				]
			: []),
	]);

	const shown = $derived(visibleItems(data.uiMode, tabs, page.url.pathname));

	const active = $derived(
		tabs.find(
			(tab) =>
				tab.href ===
				currentHref(
					page.url.pathname,
					tabs.map((candidate) => candidate.href),
				),
		)?.id ?? "monitoring",
	);
</script>

<div class="p-5 md:p-6">
  <div class="mb-6">
    <h1 class="text-text text-lg font-semibold tracking-tight">Monitoring</h1>
    <p class="text-text-muted mt-1 text-sm">
      Traffic and uptime across every service, this host's CPU and memory, and
      the traces of Homerun's own jobs.
    </p>
  </div>

  {#if shown.length > 1}
    <TabNav {active} tabs={shown}>
      {@render children()}
    </TabNav>
  {:else}
    {@render children()}
  {/if}
</div>
