<script lang="ts">
	import { List, SquareKanban } from "@lucide/svelte";
	import SectionNav from "#lib/components/section-nav.svelte";
	import { resolve } from "$app/paths";

	const { serviceId }: { serviceId: string } = $props();

	const sections = $derived([
		{
			href: resolve("/(protected)/services/[serviceId]/observability/errors", {
				serviceId,
			}),
			icon: List,
			label: "List",
		},
		{
			href: resolve(
				"/(protected)/services/[serviceId]/observability/errors/board",
				{ serviceId },
			),
			icon: SquareKanban,
			label: "Board",
		},
	]);
</script>

<SectionNav label="Issue views" sections={sections} />
