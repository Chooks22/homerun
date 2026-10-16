<script lang="ts">
	import {
		ExternalLink,
		LayoutGrid,
		RefreshCw,
		Settings,
	} from "@lucide/svelte";
	import Alert from "#lib/components/alert.svelte";
	import TabNav from "#lib/components/tab-nav.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { timeAgo } from "#lib/formatting.js";
	import { GIT_PROVIDER_KIND_LABELS } from "#lib/git-provider-kinds.js";
	import { queuedJobToast } from "#lib/job-toast.js";
	import { title } from "#lib/store/title.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { data, children } = $props();
	const repo = $derived(data.repository);

	$effect(() => {
		title.set(repo.fullName);
	});

	const overviewHref = $derived(
		resolve("/(protected)/pipelines/[repositoryId]", { repositoryId: repo.id }),
	);

	const tabs = $derived([
		{ href: overviewHref, icon: LayoutGrid, id: "overview", label: "Overview" },
		{
			href: resolve("/(protected)/pipelines/[repositoryId]/settings", {
				repositoryId: repo.id,
			}),
			icon: Settings,
			id: "settings",
			label: "Settings",
		},
	]);

	const activeTabId = $derived(
		tabs.findLast((tab) => page.url.pathname.startsWith(tab.href))?.id ?? "",
	);

	let syncing = $state(false);
</script>

<div class="p-5 md:p-6">
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-text flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span class="truncate">{repo.fullName}</span>
        <a
          class="text-text-subtle hover:text-accent"
          aria-label="Open on {GIT_PROVIDER_KIND_LABELS[repo.providerKind]}"
          href={repo.webUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink class="size-4" />
        </a>
      </h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {GIT_PROVIDER_KIND_LABELS[repo.providerKind]}
        · {repo.pipelinesEnabled ? "synced every five minutes" : "sync off"}
        {#if repo.pipelinesSyncedAt}
          · last {timeAgo(repo.pipelinesSyncedAt)}
        {/if}
        {#if data.linkedServices.length}
          · linked to {data.linkedServices.map((linked) => linked.name).join(", ")}
        {/if}
      </p>
    </div>
    <form
      action="{overviewHref}?/sync"
      method="POST"
      use:enhance={queuedJobToast({
        error: "Couldn't queue the sync.",
        loading: "Queueing the sync",
        onSettled: () => {
          syncing = false;
        },
        onStart: () => {
          syncing = true;
        },
        success: "Sync queued: its log follows under Scheduling.",
      })}
    >
      <Button disabled={syncing} size="sm" type="submit" variant="outline">
        {#if syncing}
          <Spinner />
        {:else}
          <RefreshCw class="size-4" />
        {/if}
        Sync now
      </Button>
    </form>
  </div>

  {#if repo.pipelinesError}
    <Alert class="mb-5" title="The last sync failed.">{repo.pipelinesError}</Alert>
  {/if}

  <TabNav active={activeTabId} {tabs}>
    {@render children()}
  </TabNav>
</div>
