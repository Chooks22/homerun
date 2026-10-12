<script lang="ts">
	import { LayoutGrid, Settings } from "@lucide/svelte";
	import TabNav from "#lib/components/tab-nav.svelte";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { data, children } = $props();
	const ws = $derived(data.workstation);

	const tabs = $derived([
		{
			href: resolve("/(protected)/workstations/[workstationId]", {
				workstationId: ws.id,
			}),
			icon: LayoutGrid,
			id: "overview",
			label: "Overview",
		},
		{
			href: resolve("/(protected)/workstations/[workstationId]/settings", {
				workstationId: ws.id,
			}),
			icon: Settings,
			id: "settings",
			label: "Settings",
		},
	]);

	const activeTabId = $derived(
		tabs.findLast((tab) => page.url.pathname.startsWith(tab.href))?.id ?? "",
	);
</script>

<div class="p-5 md:p-6">
  <div class="mb-6">
    <h1 class="text-text text-lg font-semibold tracking-tight">{ws.name}</h1>
    <p class="text-text-muted mt-1 text-sm">
      {ws.image} · {data.hostName ?? "this server"} · {data.hostname}
    </p>
  </div>

  <TabNav active={activeTabId} {tabs}>
    {@render children()}
  </TabNav>
</div>
