<script lang="ts">
	import {
		Cpu,
		ExternalLink,
		FileText,
		HardDrive,
		Layers,
		LayoutGrid,
		Network,
		Server,
		Settings,
		ShieldCheck,
		Terminal,
	} from "@lucide/svelte";
	import CopyButton from "#lib/components/copy-button.svelte";
	import StatusBadge from "#lib/components/status-badge.svelte";
	import TabNav, { type NavTab } from "#lib/components/tab-nav.svelte";
	import TemplateIcon from "#lib/components/template-icon.svelte";
	import * as Select from "#lib/components/ui/select/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import { syncServiceStatuses } from "#lib/remote/service-status.remote.js";
	import { primaryHostname } from "#lib/service-domains.js";
	import { internalUrl, maskUrlPassword } from "#lib/service-link.js";
	import { currentHref, visibleIn } from "#lib/ui-mode.js";
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { data, children } = $props();

	const svc = $derived(data.service);
	const synced = $derived(
		syncServiceStatuses(svc.containerId || svc.swarmServiceId ? [svc.id] : []),
	);
	const liveStatus = $derived(
		synced.current?.find((row) => row.id === svc.id)?.status ??
			svc.currentStatus,
	);
	const publicDomains = $derived.by(() => {
		const main = svc.dnsResolvable
			? primaryHostname(svc, data.stackSlug, data.serviceDomain)
			: null;
		return main ? [main] : [];
	});

	interface RouteTab extends NavTab {
		exact: boolean;
		href: string;
		link?: string;
	}

	const tabs = $derived<RouteTab[]>([
		{
			exact: true,
			href: resolve("/(protected)/services/[serviceId]", { serviceId: svc.id }),
			icon: LayoutGrid,
			id: "overview",
			label: "Overview",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/environments", {
				serviceId: svc.id,
			}),
			description: data.lastDeployedAt
				? `Deployed ${timeAgo(data.lastDeployedAt)}`
				: undefined,
			icon: Layers,
			id: "environments",
			label: "Environments & Deployments",
			link: visibleIn(data.uiMode, "service/environments/environments")
				? undefined
				: resolve("/(protected)/services/[serviceId]/environments/source", {
						serviceId: svc.id,
					}),
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/observability", {
				serviceId: svc.id,
			}),
			description:
				data.openErrors > 0
					? `${data.openErrors} open ${data.openErrors === 1 ? "error" : "errors"}`
					: undefined,
			hasWarning: data.openErrors > 0,
			icon: FileText,
			id: "observability",
			label: "Observability",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/volumes", {
				serviceId: svc.id,
			}),
			icon: HardDrive,
			id: "volumes",
			label: "Storage",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/networking", {
				serviceId: svc.id,
			}),
			description: publicDomains[0] ?? "Not publicly routed",
			icon: Network,
			id: "networking",
			label: "Networking",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/container", {
				serviceId: svc.id,
			}),
			icon: Cpu,
			id: "container",
			label: "Container",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/security", {
				serviceId: svc.id,
			}),
			icon: ShieldCheck,
			id: "security",
			label: "Security",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/terminal", {
				serviceId: svc.id,
			}),
			icon: Terminal,
			id: "terminal",
			label: "Terminal",
		},
		{
			exact: false,
			href: resolve("/(protected)/services/[serviceId]/settings", {
				serviceId: svc.id,
			}),
			icon: Settings,
			id: "settings",
			label: "Settings",
		},
	]);

	function isActive(href: string, exact: boolean): boolean {
		if (exact) {
			return page.url.pathname === href;
		}
		return page.url.pathname.startsWith(href);
	}

	const activeTabId = $derived(
		tabs.find((tab) => isActive(tab.href, tab.exact))?.id ?? "",
	);

	const currentTab = $derived(
		currentHref(
			page.url.pathname,
			tabs.map((tab) => tab.href),
		),
	);

	const shownTabs = $derived(
		tabs
			.filter(
				(tab) =>
					tab.href === currentTab ||
					visibleIn(data.uiMode, `service/${tab.id}`),
			)
			.map((tab) => ({ ...tab, href: tab.link ?? tab.href })),
	);
</script>

<div class="p-5 md:p-6">
  <!-- ── Hero ─────────────────────────────────────────────── -->
  <div class="mb-6 flex flex-wrap items-center gap-3">
    <TemplateIcon
      category={svc.category}
      class="size-9 rounded-lg"
      fallback={Server}
      icon={svc.icon}
    />
    <h1 class="text-text text-lg font-semibold tracking-tight">{svc.name}</h1>
    <StatusBadge status={liveStatus} />
    {#if data.environments.length > 0}
      <Select.Root
        onValueChange={(id) =>
          void goto(page.url.pathname.replace(`/services/${svc.id}`, `/services/${id}`))}
        type="single"
        value={svc.id}
      >
        <Select.Trigger
          class="h-6! rounded-full py-0 pr-1.5 pl-2 text-xs font-medium capitalize"
          aria-label="Environment"
        >
          <span class="inline-flex items-center gap-1">
            <Layers class="text-accent size-3" />
            {data.environments.find((env) => env.id === svc.id)?.name ?? "production"}
          </span>
        </Select.Trigger>
        <Select.Content>
          {#each data.environments as env (env.id)}
            <Select.Item class="capitalize" label={env.name} value={env.id} />
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  </div>
  <p class="text-text-muted -mt-4 mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span>
      {svc.image
        ? `${svc.image}:${svc.tag}`
        : `${svc.gitRepo ?? (svc.gitUrl ?? "").replace(/^https?:\/\//, "").replace(/\.git$/, "")}@${svc.gitRef ?? "main"}`}
    </span>
    {#if publicDomains.length > 0}
      {#each publicDomains as domain (domain)}
        <span aria-hidden="true">·</span>
        <a
          class="text-accent inline-flex items-center gap-1 hover:underline"
          href="{data.publicScheme}://{domain}"
          rel="noopener noreferrer"
          target="_blank"
        >
          {domain}
          <ExternalLink class="size-3" />
        </a>
      {/each}
    {:else}
      <span aria-hidden="true">·</span>
      <span class="text-text-subtle">not publicly routed</span>
    {/if}
    {#if svc.containerId || svc.swarmServiceId}
      {@const internal = internalUrl({
        command: svc.command,
        containerPort: svc.containerPort,
        envVars: svc.envVars ?? {},
        image: svc.image,
        name: svc.name,
        slug: svc.slug,
      })}
      <span aria-hidden="true">·</span>
      <span class="text-text-subtle inline-flex items-center gap-0.5">
        internal: {maskUrlPassword(internal)}
        <CopyButton class="p-0.5" label="internal URL" value={internal} />
      </span>
    {/if}
    {#if data.openErrors > 0}
      <span aria-hidden="true">·</span>
      <a
        class="text-red-600 hover:underline dark:text-red-400"
        href={resolve("/(protected)/services/[serviceId]/observability/errors", {
          serviceId: svc.id,
        })}
      >
        {data.openErrors} open {data.openErrors === 1 ? "error" : "errors"}
      </a>
    {/if}
    {#if data.lastDeployedAt}
      <span aria-hidden="true">·</span>
      <span
        class="text-text-subtle"
        title={new Date(data.lastDeployedAt).toLocaleString()}
      >
        deployed {timeAgo(data.lastDeployedAt)}
      </span>
    {/if}
  </p>

  <!-- ── Tabs ─────────────────────────────────────────────── -->
  <TabNav active={activeTabId} tabs={shownTabs}>
    {@render children()}
  </TabNav>
</div>
