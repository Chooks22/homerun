<script lang="ts">
	import {
		Bug,
		CircleCheck,
		EyeOff,
		KeyRound,
		Loader2,
		Power,
		RotateCcw,
	} from "@lucide/svelte";

	import { onMount } from "svelte";
	import BulkActionBar from "#lib/components/bulk-action-bar.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import CopyButton from "#lib/components/copy-button.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityList from "#lib/components/entity-list.svelte";
	import EntityToolbar, {
		type FilterGroup,
	} from "#lib/components/entity-toolbar.svelte";
	import ErrorLevelBadge from "#lib/components/error-level-badge.svelte";
	import Pagination from "#lib/components/pagination.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import SelectAllRow from "#lib/components/select-all-row.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { sdkSnippets } from "#lib/error-tracking/snippets.js";
	import { timeAgo } from "#lib/formatting.js";
	import { ListSelection } from "#lib/list-selection.svelte.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { enhance, type SubmitFunction } from "$app/forms";
	import { resolve } from "$app/paths";
	import IssueViewsNav from "./issue-views-nav.svelte";
	import SourceMapsPanel from "./source-maps-panel.svelte";

	const { data } = $props();
	const svc = $derived(data.service);

	onMount(() => title.set(`${svc.name} · Errors`));

	const view = new ViewMode("errors");

	const filters: FilterGroup[] = [
		{
			key: "status",
			label: "Status",
			options: [
				{ label: "Unresolved", value: "unresolved" },
				{ label: "Resolved", value: "resolved" },
				{ label: "Ignored", value: "ignored" },
				{ label: "All", value: "all" },
			],
		},
	];

	const sorts = [
		{ label: "Last seen", value: "-lastSeen" },
		{ label: "First seen", value: "-firstSeen" },
		{ label: "Most events", value: "-count" },
	];

	const issues = $derived(data.issues?.items ?? []);
	const selection = new ListSelection(() => issues.map((issue) => issue.id));

	const serverDsn = $derived(
		data.project
			? ((data.project.internalDsn ? data.dsns?.internal : null) ??
					data.dsns?.public ??
					"")
			: "",
	);

	const snippets = $derived(
		sdkSnippets(data.dsns?.public ?? "", serverDsn, !!data.project?.injectEnv),
	);
	let snippetId = $state("node");
	const snippet = $derived(
		snippets.find((candidate) => candidate.id === snippetId) ?? snippets[0],
	);
	let toggling = $state(false);
	let savingSettings = $state(false);
	let rotateOpen = $state(false);
	let rotateForm = $state<HTMLFormElement | null>(null);
	let bulkPending = $state(false);
	let bulkStatus = $state("resolved");

	const STATUS_DONE: Record<string, string> = {
		ignored: "ignored",
		resolved: "resolved",
		unresolved: "reopened",
	};

	function plural(count: number): string {
		return count === 1 ? "issue" : "issues";
	}

	const bulkSubmit: SubmitFunction = (input) => {
		const count = selection.count;
		return enhanceToast({
			error: `Couldn't update the selected ${plural(count)}.`,
			loading: `Updating ${count} ${plural(count)}`,
			onSettled: () => {
				bulkPending = false;
			},
			onStart: () => {
				bulkPending = true;
			},
			onSuccess: () => {
				selection.clear();
			},
			success: (result) => {
				const changed =
					(result as { changed?: number } | undefined)?.changed ?? count;
				return `${changed} ${plural(changed)} ${STATUS_DONE[bulkStatus]}.`;
			},
		})(input);
	};

	function issueHref(issueId: string): string {
		return resolve(
			"/(protected)/services/[serviceId]/observability/errors/[issueId]/[[eventId]]",
			{
				issueId,
				serviceId: svc.id,
			},
		);
	}
</script>

{#snippet toggleForm(enabled: boolean)}
  <form
    action={enabled ? "?/disable" : "?/enable"}
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't change error tracking.",
      loading: enabled ? "Turning error tracking off" : "Turning error tracking on",
      onSettled: () => {
        toggling = false;
      },
      onStart: () => {
        toggling = true;
      },
      success: (result) =>
        result?.enabled ? "Error tracking is on." : "Error tracking is off.",
    })}
  >
    <Button disabled={toggling} size="sm" type="submit" variant={enabled ? "outline" : "default"}>
      {#if toggling}
        <Loader2 class="size-3.5 animate-spin" />
      {:else}
        <Power class="size-3.5" />
      {/if}
      {enabled ? "Turn off" : "Turn on error tracking"}
    </Button>
  </form>
{/snippet}

<div class="space-y-6 {selection.count > 0 ? 'pb-28' : ''}">
  {#if data.parentId}
    <section class="panel rounded-md p-5">
      <p class="text-text-muted text-sm">
        Previews and canaries report into their parent service's project, under
        the <code>preview</code> or <code>canary</code> environment.
        <a
          class="text-accent hover:underline"
          href={resolve("/(protected)/services/[serviceId]/observability/errors", {
            serviceId: data.parentId,
          })}
        >Open the parent's errors</a>.
      </p>
    </section>
  {:else if !data.project}
    <EmptyState
      icon={Bug}
      subtitle="Point any Sentry SDK at Homerun to group the errors this service throws into issues, with stack traces linked back to your code."
      title="Error tracking is off"
    >
      {#snippet children()}
        {@render toggleForm(false)}
      {/snippet}
    </EmptyState>
  {:else}
    <IssueViewsNav serviceId={svc.id} />

    <section class="panel rounded-md">
      <PanelHeader
        description={data.project.enabled
          ? "Any official Sentry SDK reports here, unchanged."
          : "Off: SDKs sending to this project are refused until it's turned back on."}
        icon={Bug}
        title="Error tracking"
      >
        {#snippet trailing()}
          {@render toggleForm(data.project?.enabled ?? false)}
          <SaveButton form="error-tracking-settings" pending={savingSettings} />
        {/snippet}
      </PanelHeader>
      <div class="space-y-5 p-5">
        <div class="space-y-3">
          {#if data.dsns?.public}
            <div>
              <p class="text-text-subtle mb-1.5 text-xs">Public DSN, for browsers and apps outside Homerun</p>
              <CopyBox label="public DSN" truncate value={data.dsns.public} />
            </div>
          {/if}
          {#if data.dsns?.internal}
            <div>
              <p class="text-text-subtle mb-1.5 text-xs">Internal DSN, over the Homerun network</p>
              <CopyBox label="internal DSN" truncate value={data.dsns.internal} />
            </div>
          {/if}
        </div>

        <form
          id="error-tracking-settings"
          action="?/settings"
          class="grid gap-3 md:grid-cols-2"
          method="POST"
          use:enhance={enhanceToast({
            error: "Check the form for errors.",
            loading: "Saving error tracking settings",
            onSettled: () => {
              savingSettings = false;
            },
            onStart: () => {
              savingSettings = true;
            },
            success: "Error tracking settings saved.",
          })}
        >
          <CheckBox
            checked={data.project.injectEnv}
            helperText="SENTRY_DSN, SENTRY_RELEASE (the deployed commit or image) and SENTRY_ENVIRONMENT, on the next deploy. Variables you set yourself win."
            id="injectEnv"
            label="Inject the SDK env at deploy"
            name="injectEnv"
          />
          <CheckBox
            checked={data.project.internalDsn}
            helperText={data.dsns?.internal
              ? "The injected DSN reaches the dashboard over the Homerun network, for apps with no route to its public URL."
              : "Not available here: the dashboard isn't running in a container on the Homerun network, so the public DSN is injected."}
            id="internalDsn"
            label="Inject the internal DSN"
            name="internalDsn"
          />
          <div class="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button
              onclick={() => rotateOpen = true}
              size="sm"
              type="button"
              variant="ghost"
            ><KeyRound class="size-3.5" />Rotate key</Button>
          </div>
        </form>
        <form
          action="?/rotateKey"
          class="hidden"
          method="POST"
          bind:this={rotateForm}
          use:enhance={enhanceToast({
            error: "Couldn't rotate the key.",
            loading: "Rotating the key",
            success: "Key rotated. Redeploy services using the old DSN.",
          })}
        ></form>

        <details class="group">
          <summary class="text-text cursor-pointer text-sm font-medium">SDK setup</summary>
          <div class="mt-3 space-y-3">
            <div class="flex flex-wrap gap-1.5">
              {#each snippets as candidate (candidate.id)}
                <Button
                  onclick={() => snippetId = candidate.id}
                  size="sm"
                  type="button"
                  variant={candidate.id === snippet.id ? "default" : "outline"}
                >
                  {candidate.label}
                </Button>
              {/each}
            </div>
            <CopyBox label="install command" value={snippet.install} />
            <div class="relative">
              <pre class="bg-surface-2 text-text overflow-x-auto rounded-md p-3 pr-10 font-mono text-xs">{snippet.code}</pre>
              <CopyButton class="absolute top-2 right-2" label="snippet" value={snippet.code} />
            </div>
            <p class="text-text-subtle text-xs">
              Up to {data.limits.eventsPerMinute} events a minute, the newest {data.limits.eventsKept}
              kept per issue, {data.limits.retentionDays} days of history. No performance
              tracing or session replay: those items are accepted and dropped.
            </p>
          </div>
        </details>
      </div>
    </section>

    <SourceMapsPanel releases={data.sourceMaps ?? []} serviceId={data.service.id} />

    <section class="space-y-3">
      <EntityToolbar
        filters={filters}
        placeholder="Search issues by title or culprit…"
        sorts={sorts}
      />

      {#if data.issues && data.issues.total === 0 && !data.filtered}
        <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
          <p class="text-text text-sm font-medium">No unresolved errors</p>
          <p class="text-text-subtle mt-1 text-xs">Issues show up here as soon as the SDK reports one.</p>
        </div>
      {:else if issues.length === 0}
        <div class="border-border/70 rounded-md border border-dashed py-16 text-center">
          <p class="text-text-muted text-sm">No issues match your filters.</p>
        </div>
      {:else}
        {#snippet badge(item: { id: string })}
          {@const issue = issues.find((candidate) => candidate.id === item.id)}
          {#if issue}
            <ErrorLevelBadge level={issue.level} />
          {/if}
        {/snippet}

        {#snippet meta(item: { id: string })}
          {@const issue = issues.find((candidate) => candidate.id === item.id)}
          {#if issue}
            <span class="text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span title="Events">{issue.count} {issue.count === 1 ? "event" : "events"}</span>
              {#if issue.usersAffected > 0}
                <span>{issue.usersAffected} {issue.usersAffected === 1 ? "user" : "users"}</span>
              {/if}
              <span title={new Date(issue.lastSeen).toLocaleString()}>{timeAgo(issue.lastSeen)}</span>
              {#if issue.status !== "unresolved"}
                <span class="text-text-subtle">{issue.status}</span>
              {:else if issue.regressedAt}
                <span class="text-amber-600">regressed</span>
              {/if}
            </span>
          {/if}
        {/snippet}

        <SelectAllRow
          noun="issues"
          selection={selection}
          visibleCount={issues.length}
        />

        <EntityList
          badge={badge}
          items={issues.map((issue) => ({
            href: issueHref(issue.id),
            id: issue.id,
            subtitle: issue.culprit,
            title: issue.title,
          }))}
          meta={meta}
          onToggleSelect={(id) => selection.toggle(id)}
          selectedIds={selection.ids}
          view={view}
        />

        {#if data.issues}
          <Pagination
            label="issues"
            page={data.issues.page}
            perPage={data.issues.perPage}
            total={data.issues.total}
          />
        {/if}
      {/if}
    </section>
  {/if}
</div>

<BulkActionBar
  action="?/status"
  idField="issueId"
  label={plural(selection.count)}
  pending={bulkPending}
  selection={selection}
  submit={bulkSubmit}
>
  <Button
    disabled={bulkPending}
    name="status"
    onclick={() => bulkStatus = "resolved"}
    size="sm"
    type="submit"
    value="resolved"
    variant="outline"
  >
    <CircleCheck class="size-3.5" />
    Resolve
  </Button>
  <Button
    disabled={bulkPending}
    name="status"
    onclick={() => bulkStatus = "ignored"}
    size="sm"
    type="submit"
    value="ignored"
    variant="outline"
  >
    <EyeOff class="size-3.5" />
    Ignore
  </Button>
  <Button
    disabled={bulkPending}
    name="status"
    onclick={() => bulkStatus = "unresolved"}
    size="sm"
    type="submit"
    value="unresolved"
    variant="outline"
  >
    <RotateCcw class="size-3.5" />
    Reopen
  </Button>
</BulkActionBar>

<ConfirmDialog
  bind:open={rotateOpen}
  confirmLabel="Rotate key"
  description="Every DSN handed out so far stops working. Services with the injected env pick up the new one on their next deploy; anything configured by hand needs the new DSN."
  onConfirm={() => rotateForm?.requestSubmit()}
  title="Rotate the DSN key"
/>
