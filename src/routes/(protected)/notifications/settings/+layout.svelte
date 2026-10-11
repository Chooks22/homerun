<script lang="ts">
	import { Send, SlidersHorizontal } from "@lucide/svelte";
	import TabNav from "#lib/components/tab-nav.svelte";
	import { can } from "#lib/permissions.js";
	import { currentHref } from "#lib/ui-mode.js";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { children, data } = $props();

	const tabs = $derived([
		{
			href: resolve("/(protected)/notifications/settings"),
			icon: SlidersHorizontal,
			id: "notifications/settings",
			label: "General",
		},
		...(can(data.permissions, "notifications", "read")
			? [
					{
						href: resolve("/(protected)/notifications/settings/channels"),
						icon: Send,
						id: "notifications/settings/channels",
						label: "Channels",
					},
				]
			: []),
	]);

	const active = $derived(
		tabs.find(
			(tab) =>
				tab.href ===
				currentHref(
					page.url.pathname,
					tabs.map((candidate) => candidate.href),
				),
		)?.id ?? "notifications/settings",
	);
</script>

<div class="p-5 md:p-6">
  <div class="mb-6">
    <h1 class="text-text text-lg font-semibold tracking-tight">
      Notification settings
    </h1>
    <p class="text-text-muted mt-1 text-sm">
      Where Homerun sends build, deploy, health and server alerts, which events
      each channel receives, and whether bursts are folded into one message.
    </p>
  </div>

  <TabNav {active} {tabs}>
    {@render children()}
  </TabNav>
</div>
