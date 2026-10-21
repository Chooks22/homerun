<script lang="ts">
	import {
		Activity,
		BarChart3,
		Bug,
		HeartPulse,
		ListChecks,
		ShieldBan,
		Workflow,
	} from "@lucide/svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import SectionNav from "#lib/components/section-nav.svelte";
	import { visibleItems } from "#lib/ui-mode.js";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { children, data } = $props();

	const sections = $derived([
		{
			href: resolve("/(protected)/services/[serviceId]/observability", {
				serviceId: data.service.id,
			}),
			icon: BarChart3,
			id: "service/observability/monitoring",
			label: "Monitoring",
		},
		{
			href: resolve("/(protected)/services/[serviceId]/observability/events", {
				serviceId: data.service.id,
			}),
			icon: ListChecks,
			id: "service/observability/events",
			label: "Events",
		},
		{
			href: resolve("/(protected)/services/[serviceId]/observability/errors", {
				serviceId: data.service.id,
			}),
			icon: Bug,
			id: "service/observability/errors",
			label: "Errors",
		},
		{
			href: resolve("/(protected)/services/[serviceId]/observability/traces", {
				serviceId: data.service.id,
			}),
			icon: Activity,
			id: "service/observability/traces",
			label: "Traces",
		},
		{
			href: resolve(
				"/(protected)/services/[serviceId]/observability/pipelines",
				{ serviceId: data.service.id },
			),
			icon: Workflow,
			id: "service/observability/pipelines",
			label: "Pipelines",
		},
		{
			href: resolve("/(protected)/services/[serviceId]/observability/blocked", {
				serviceId: data.service.id,
			}),
			icon: ShieldBan,
			id: "service/observability/blocked",
			label: "Blocked IPs",
		},
		{
			href: resolve("/(protected)/services/[serviceId]/observability/health", {
				serviceId: data.service.id,
			}),
			icon: HeartPulse,
			id: "service/observability/health",
			label: "Health",
		},
	]);
</script>

<SectionNav
  label="Observability sections"
  sections={visibleItems(data.uiMode, sections, page.url.pathname)}
/>

<ErrorBoundary title="This section hit an error while rendering.">
  {@render children()}
</ErrorBoundary>
