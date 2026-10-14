<script lang="ts">
	import { ArrowLeft, KeyRound, ScrollText, Settings } from "@lucide/svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import SectionNav from "#lib/components/section-nav.svelte";
	import { resolve } from "$app/paths";

	const { children, data } = $props();

	const params = $derived({ accountId: data.account.id });
	const sections = $derived([
		{
			href: resolve("/(protected)/service-accounts/[accountId]", params),
			icon: KeyRound,
			label: "API keys",
		},
		{
			href: resolve(
				"/(protected)/service-accounts/[accountId]/activity",
				params,
			),
			icon: ScrollText,
			label: "Activity",
		},
		{
			href: resolve(
				"/(protected)/service-accounts/[accountId]/settings",
				params,
			),
			icon: Settings,
			label: "Settings",
		},
	]);
</script>

<div class="p-5 md:p-6">
  <a
    class="text-text-muted hover:text-text mb-5 inline-flex items-center gap-1 text-sm"
    href={resolve("service-accounts")}
  >
    <ArrowLeft class="size-4" />
    All service accounts
  </a>

  <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">
        {data.account.name}
        {#if data.account.disabled}
          <span class="bg-surface-2 text-text-subtle ml-1.5 rounded-full px-2 py-0.5 align-middle text-[0.65rem] font-semibold">
            Disabled
          </span>
        {/if}
      </h1>
      <p class="text-text-muted mt-1 text-sm">
        Tick it in a login wall's allowed users, or put this id in
        <code>preview_auth_allowed_user_ids</code>.
      </p>
    </div>
    <CopyBox class="sm:w-96" label="the service account id" value={data.account.id} />
  </div>

  <SectionNav label="Service account sections" {sections} />
  <ErrorBoundary title="This section hit an error while rendering.">
    {@render children()}
  </ErrorBoundary>
</div>
