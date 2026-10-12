<script lang="ts">
	import {
		Play,
		Settings,
		SlidersHorizontal,
		SquareTerminal,
	} from "@lucide/svelte";
	import TabNav from "#lib/components/tab-nav.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { describeCronJobTarget } from "#lib/cron-job-script.js";
	import { timeAgo } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";

	const { data, children } = $props();
	const job = $derived(data.job);

	$effect(() => {
		title.set(job.name);
	});

	const runsHref = $derived(
		resolve("/(protected)/cron-jobs/[cronJobId]", { cronJobId: job.id }),
	);

	const tabs = $derived([
		{ href: runsHref, icon: SquareTerminal, id: "runs", label: "Runs" },
		{
			href: resolve("/(protected)/cron-jobs/[cronJobId]/configuration", {
				cronJobId: job.id,
			}),
			icon: SlidersHorizontal,
			id: "configuration",
			label: "Configuration",
		},
		{
			href: resolve("/(protected)/cron-jobs/[cronJobId]/settings", {
				cronJobId: job.id,
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
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">{job.name}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {job.enabled ? job.schedule : "manual only"}
        · {job.kind === "exec" ? "host command" : describeCronJobTarget(job)}
        {#if job.lastRunAt}
          · last run {timeAgo(job.lastRunAt)}
        {/if}
      </p>
    </div>
    <form
      action="{runsHref}?/runNow"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't queue that run.",
        loading: "Queueing the run",
        success: "Run queued : it shows up under Runs.",
      })}
    >
      <Button size="sm" type="submit" variant="outline">
        <Play class="size-4" />
        Run now
      </Button>
    </form>
  </div>

  <TabNav active={activeTabId} {tabs}>
    {@render children()}
  </TabNav>
</div>
