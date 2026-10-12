<script lang="ts">
	import {
		AlertTriangle,
		ArrowRight,
		CircleX,
		Clock,
		Plus,
		Rocket,
		Server,
	} from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import ErrorBoundary from "#lib/components/error-boundary.svelte";
	import HostResources from "#lib/components/host-resources.svelte";
	import MonitoringSummary from "#lib/components/monitoring/monitoring-summary.svelte";
	import ServiceUsageTable from "#lib/components/service-usage-table.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import StatusBadge from "#lib/components/status-badge.svelte";
	import TemplateIcon from "#lib/components/template-icon.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { timeAgo } from "#lib/formatting.js";
	import { can } from "#lib/permissions.js";
	import {
		getSetupStatus,
		reapplyTraefikConfig,
	} from "#lib/remote/setup.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast, toastError } from "#lib/toast.js";
	import type { ContainerStatus } from "#lib/types.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	const setup = getSetupStatus();
	const setupIssues = $derived(
		(setup.current?.checks ?? []).filter((check) => check.severity !== "ok"),
	);
	let reviewOpen = $state(false);
	let reapplying = $state(false);

	async function reapplyCallback() {
		reapplying = true;
		try {
			await reapplyTraefikConfig();
		} finally {
			reapplying = false;
		}
	}

	function handleReapply() {
		return toast.promise(reapplyCallback(), {
			error: (error) =>
				toastError(error, "Couldn't re-apply the Traefik configuration."),
			loading: "Re-applying the Traefik configuration",
			success: "Traefik is back on the settings' configuration.",
		});
	}
	let clearingErrors = $state(false);
	let quickDeploying = $state<string | null>(null);

	function quickDeployEnhance(template: { id: string; name: string }) {
		return enhanceToast({
			error: "Couldn't prepare deployment.",
			loading: `Preparing "${template.name}" for deployment`,
			onSettled: () => {
				quickDeploying = null;
			},
			onStart: () => {
				quickDeploying = template.id;
			},
			success: `"${template.name}" deploying`,
		});
	}

	onMount(() => {
		title.set("Dashboard");
	});

	function statusDot(status: ContainerStatus): string {
		if (status === "running") {
			return "bg-emerald-500";
		}
		if (status === "failed" || status === "missing") {
			return "bg-red-500";
		}
		if (status === "stopped") {
			return "bg-zinc-400";
		}
		return "bg-amber-500";
	}

	const statCards = $derived([
		{
			dot: "bg-accent",
			label: "Services",
			value: String(data.stats.totalServices),
		},
		{
			dot: "bg-emerald-500",
			label: "Running",
			value: String(data.stats.running),
		},
	]);
</script>

<div class="p-5 md:p-6">
  <div class="mb-5">
    <h1 class="text-text text-lg font-semibold tracking-tight">
      Welcome back, {data.user?.name?.split(" ")[0]}
    </h1>
    <p class="text-text-muted mt-0.5 text-xs">
      Here's an overview of your deployed services.
    </p>
  </div>

  {#if setupIssues.length > 0}
    <div class="mb-5 border border-amber-400/40 bg-amber-400/10 text-xs">
      <button
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-amber-400/15"
        aria-expanded={reviewOpen}
        onclick={() => {
          reviewOpen = !reviewOpen;
        }}
        type="button"
      >
        <AlertTriangle class="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span class="flex-1 text-amber-700 dark:text-amber-300">
          {setupIssues.length}
          {setupIssues.length === 1 ? "setup issue" : "setup issues"}
          found : {setupIssues[0].label.toLowerCase()}
          {setupIssues.length > 1 ? ", and more" : ""}.
        </span>
        <span class="eyebrow shrink-0 text-amber-700 dark:text-amber-400">
          {reviewOpen ? "Hide" : "Review"}
        </span>
      </button>
      {#if reviewOpen}
        <ul class="divide-y divide-amber-400/30 border-t border-amber-400/30">
          {#each setupIssues as issue (issue.id)}
            {@const fields = setup.current?.fieldsByCheck[issue.id] ?? []}
            <li class="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="text-text font-medium">
                  <span class="mr-1.5 inline-block size-1.5 rounded-full align-middle {issue.severity === 'danger'
                  ? 'bg-red-500'
                  : 'bg-amber-500'}"></span>
                  {issue.label}
                </p>
                <p class="text-text-muted mt-0.5">{issue.detail}</p>
                {#if issue.envVar}
                  <p class="text-text-subtle mt-0.5">
                    Env var : <code>{issue.envVar}</code>
                  </p>
                {/if}
              </div>
              {#if issue.action === "reapply-traefik" && can(data.permissions, "settings", "write")}
                <button
                  class="eyebrow shrink-0 text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-400"
                  disabled={reapplying}
                  onclick={handleReapply}
                  type="button"
                >
                  Re-apply
                </button>
              {/if}
              {#if fields.length > 0}
                <a
                  class="eyebrow shrink-0 text-amber-700 hover:underline dark:text-amber-400"
                  href="{resolve('settings')}?highlight={fields.join(',')}"
                >Fix in settings</a>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if data.overCapacity.length > 0}
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-2.5 text-xs">
      <CircleX class="size-3.5 shrink-0 text-red-500" />
      <p class="min-w-0 flex-1 text-red-700 dark:text-red-300">
        <span class="font-medium">Server past its hard resource limit:</span>
        {data.overCapacity.join(", ")}. New services are refused until usage
        drops back.
      </p>
      {#if data.readsSettings}
        <a
          class="eyebrow shrink-0 text-red-700 hover:underline dark:text-red-400"
          href={resolve('settings')}
        >Limits</a>
      {/if}
    </div>
  {/if}

  {#if data.uptimeDown.length > 0}
    <div class="mb-4 rounded-xl border border-red-400/40 bg-red-500/10">
      <div class="flex items-center gap-2 border-b border-red-400/30 px-4 py-2.5">
        <CircleX class="size-3.5 text-red-500" />
        <span class="text-sm font-medium text-red-600 dark:text-red-400">
          {data.uptimeDown.length}
          {data.uptimeDown.length === 1 ? "probe is" : "probes are"} failing
        </span>
      </div>
      <div class="divide-y divide-red-400/20">
        {#each data.uptimeDown as check (check.serviceId + check.kind)}
          <a
            class="flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-red-500/10"
            href="{resolve('services')}/{check.serviceId}/observability/events"
          >
            <span class="text-text truncate font-medium">{check.serviceName}</span>
            <span class="text-text-muted">
              {check.kind === "internal" ? "not answering on the network" : "hostname not responding"}
            </span>
            <span class="text-text-subtle ml-auto truncate">
              {check.detail ?? ""}{check.target ? ` (${check.target})` : ""}
            </span>
          </a>
        {/each}
      </div>
    </div>
  {/if}

  {#if data.frontPageTemplates.length > 0}
    <section class="panel mb-4 rounded-xl">
      <div class="panel-head">
        <h2 class="eyebrow flex items-center gap-1.5">
          <Rocket class="size-3.5" />
          Deploy an app
        </h2>
        <a
          class="text-accent ml-auto text-xs font-medium hover:underline"
          href={resolve('templates')}
        >Browse all templates</a>
      </div>
      <div class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {#each data.frontPageTemplates as template (template.id)}
          <div class="border-border flex flex-col gap-3 rounded-lg border p-3">
            <a
              class="flex min-w-0 flex-1 items-start gap-3"
              href={resolve("/(protected)/templates/[templateId]", {
                templateId: template.id,
              })}
            >
              <TemplateIcon
                category={template.category}
                class="size-9 shrink-0"
                icon={template.icon}
              />
              <span class="min-w-0">
                <span class="text-text block truncate text-sm font-medium">{template.name}</span>
                <span class="text-text-muted line-clamp-2 text-xs">{template.description}</span>
              </span>
            </a>
            <form
              action="{resolve('templates')}?/quickDeploy"
              method="POST"
              use:enhance={quickDeployEnhance(template)}
            >
              <input name="templateId" type="hidden" value={template.id}>
              <Button
                class="w-full"
                disabled={quickDeploying !== null}
                size="sm"
                type="submit"
              >
                {#if quickDeploying === template.id}
                  <Spinner />
                  Deploying…
                {:else}
                  <Rocket class="size-3.5" />
                  Quick Deploy
                {/if}
              </Button>
            </form>
          </div>
        {/each}
      </div>
      <div class="border-border flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <p class="text-text-muted flex-1 text-xs">
          Not in the list? Browse all templates, or point at any Docker image.
        </p>
        <Button href={resolve('services/new')} size="sm" variant="outline">
          <Plus class="size-3.5" />
          Deploy an image
        </Button>
      </div>
    </section>
  {/if}

  <div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
    <div class="panel divide-border flex divide-x rounded-xl">
      {#each statCards as card (card.label)}
        <div class="min-w-0 flex-1 px-4 py-3">
          <p class="eyebrow flex items-center gap-1.5">
            <span class="size-1.5 rounded-full {card.dot}"></span>
            {card.label}
          </p>
          <p class="metric mt-2">{card.value}</p>
        </div>
      {/each}
    </div>

    <ErrorBoundary title="Host resources didn't load.">
      <HostResources />
    </ErrorBoundary>
  </div>

  <div class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
    {#await data.monitoring}
      <div class="panel rounded-xl p-4">
        <Skeleton class="h-56 w-full" />
      </div>
    {:then summary}
      <MonitoringSummary
        busiest={summary.busiest}
        href={resolve('monitoring')}
        monitoring={summary.monitoring}
      />
    {:catch}
      <div class="panel text-text-muted rounded-xl p-4 text-sm">
        Couldn't load today's monitoring.
      </div>
    {/await}
    <ErrorBoundary title="Resource usage didn't load.">
      <ServiceUsageTable limit={5} />
    </ErrorBoundary>
  </div>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
    <div class="panel rounded-xl lg:col-span-2 xl:col-span-1">
      <div class="panel-head">
        <h2 class="eyebrow flex items-center gap-1.5">
          <Clock class="size-3" />
          Recent Deployments
        </h2>
        <a
          class="text-accent text-xs font-medium hover:underline"
          href={resolve('deployments')}
        >View all</a>
      </div>

      {#if data.recentDeployments.length === 0}
        <div class="flex flex-col items-center justify-center px-4 py-10 text-center">
          <Server class="text-text-subtle mb-2 size-5" />
          <p class="text-text-muted text-xs">No deployments yet</p>
          <p class="text-text-subtle mt-0.5 text-[0.6875rem]">
            Deploy your first service to get started
          </p>
        </div>
      {:else}
        <div class="divide-border divide-y">
          {#each data.recentDeployments as dep (dep.id)}
            <a
              class="hover:bg-surface-2 flex items-start gap-3 px-4 py-2.5 transition-colors"
              href="{resolve('services')}/{dep.serviceId}"
            >
              <span class="mt-1.5 size-1.5 shrink-0 rounded-full {statusDot(dep.status)}"></span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                  <span class="text-text truncate text-sm font-medium">
                    {dep.serviceName ?? "Unknown service"}
                  </span>
                  <StatusBadge status={dep.status} />
                </span>
                <span class="text-text-subtle mt-0.5 block truncate text-xs">
                  {dep.serviceSlug ?? ""}
                  {#if dep.imageDigest}
                    · {dep.imageDigest.slice(0, 19)}
                  {/if}
                  {#if dep.startedAt && dep.finishedAt}
                    · took {Math.max(
                      1,
                      Math.round(
                        (new Date(dep.finishedAt).getTime() -
                          new Date(dep.startedAt).getTime()) /
                          1000,
                      ),
                    )}s
                  {/if}
                </span>
                {#if dep.errorMessage}
                  <span class="mt-0.5 block truncate text-xs text-red-500">
                    {dep.errorMessage}
                  </span>
                {/if}
              </span>
              <span class="tabular-nums text-text-subtle mt-0.5 shrink-0 text-[0.6875rem]">
                {timeAgo(dep.createdAt)}
              </span>
            </a>
          {/each}
        </div>
      {/if}
    </div>

    <div class="panel rounded-xl">
      <div class="panel-head">
        <h2 class="eyebrow flex items-center gap-1.5">
          <AlertTriangle class="size-3" />
          Recent errors
        </h2>
        <div class="flex items-center gap-3">
          {#if data.recentErrors.length > 0}
            <form
              action="?/clearErrors"
              method="POST"
              use:enhance={enhanceToast({
                error: "Couldn't clear the errors.",
                loading: "Clearing errors",
                onSettled: () => {
                  clearingErrors = false;
                },
                onStart: () => {
                  clearingErrors = true;
                },
                success: "Errors cleared.",
              })}
            >
              <button
                class="text-text-muted hover:text-text text-xs font-medium disabled:opacity-50"
                disabled={clearingErrors}
                type="submit"
              >
                Clear
              </button>
            </form>
          {/if}
          {#if data.readsSystem}
            <a
              class="text-accent text-xs font-medium hover:underline"
              href={resolve('system-logs')}
            >System logs</a>
          {/if}
        </div>
      </div>
      {#if data.recentErrors.length === 0}
        <p class="text-text-muted px-4 py-6 text-center text-xs">
          Nothing logged at warn or error level.
        </p>
      {:else}
        <div class="divide-border divide-y">
          {#each data.recentErrors as entry (entry.id)}
            {@const href = entry.serviceId
              ? `${resolve('services')}/${entry.serviceId}/observability/events`
              : resolve('system-logs')}

            <a
              class="hover:bg-surface-2 block px-4 py-2.5 transition-colors"
              href={href}
            >
              <span class="flex items-center gap-2">
                <span
                  class="size-1.5 shrink-0 rounded-full {entry.level === 'error'
                  ? 'bg-red-500'
                  : 'bg-amber-500'}"
                ></span>
                <span class="text-text truncate text-xs font-medium">
                  {entry.serviceName ?? entry.scope ?? "Instance"}
                </span>
                <span class="tabular-nums text-text-subtle ml-auto shrink-0 text-[0.6875rem]">
                  {timeAgo(entry.createdAt)}
                </span>
              </span>
              <span class="text-text-muted mt-0.5 line-clamp-2 text-xs">
                {entry.message}
              </span>
            </a>
          {/each}
        </div>
      {/if}
    </div>

    <div class="panel rounded-xl">
      <div class="panel-head">
        <h2 class="eyebrow">Quick Actions</h2>
      </div>
      <div class="divide-border divide-y">
        <a
          class="hover:bg-surface-2 group/qa flex items-center gap-3 px-3.5 py-2.5 transition-colors"
          href={resolve('services/new')}
        >
          <Server class="text-text-subtle group-hover/qa:text-accent size-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="text-text block text-sm font-medium">Deploy a Service</span>
            <span class="text-text-subtle block text-[0.6875rem]">
              Point at an image, click deploy
            </span>
          </span>
          <Plus class="text-text-subtle size-3.5 shrink-0" />
        </a>

        {#if data.stats.totalServices > 0}
          <a
            class="hover:bg-surface-2 group/qa flex items-center gap-3 px-3.5 py-2.5 transition-colors"
            href={resolve('services')}
          >
            <Server class="text-text-subtle group-hover/qa:text-accent size-4 shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="text-text block text-sm font-medium">All Services</span>
              <span class="text-text-subtle block text-[0.6875rem]">
                View and manage services
              </span>
            </span>
            <ArrowRight class="text-text-subtle size-3.5 shrink-0" />
          </a>
        {/if}
      </div>
    </div>
  </div>
</div>
