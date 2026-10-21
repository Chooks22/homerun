<script lang="ts">
	import { ArrowLeft, Link2, Settings } from "@lucide/svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import SectionNav from "#lib/components/section-nav.svelte";
	import { resolve } from "$app/paths";

	const { children, data } = $props();

	const kindLabels: Record<string, string> = {
		bitbucket: "Bitbucket",
		gitea: "Gitea",
		github: "GitHub App",
		gitlab: "GitLab",
	};

	const params = $derived({ providerId: data.provider.id });
	const sections = $derived([
		{
			href: resolve("/(protected)/git-providers/[providerId]", params),
			icon: Link2,
			label: "Connection",
		},
		...(data.canWrite
			? [
					{
						href: resolve(
							"/(protected)/git-providers/[providerId]/settings",
							params,
						),
						icon: Settings,
						label: "Settings",
					},
				]
			: []),
	]);
</script>

<div class="p-5 md:p-6">
  <a
    class="text-text-muted hover:text-text mb-5 inline-flex items-center gap-1 text-sm"
    href={resolve("git-providers")}
  >
    <ArrowLeft class="size-4" />
    All git providers
  </a>

  <div class="mb-6">
    <h1 class="text-text text-lg font-semibold tracking-tight">
      {data.provider.name}
      {#if !data.provider.enabled}
        <span class="bg-surface-2 text-text-subtle ml-1.5 rounded-full px-2 py-0.5 align-middle text-[0.65rem] font-semibold">
          Disabled
        </span>
      {/if}
    </h1>
    <p class="text-text-muted mt-1 text-sm">
      {kindLabels[data.provider.kind] ?? data.provider.kind}{data.provider.baseUrl ? ` · ${data.provider.baseUrl}` : ""}
    </p>
  </div>

  <SectionNav label="Git provider sections" {sections} />
  <ErrorBoundary title="This section hit an error while rendering.">
    {@render children()}
  </ErrorBoundary>
</div>
