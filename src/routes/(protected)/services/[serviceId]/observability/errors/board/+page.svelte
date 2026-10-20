<script lang="ts">
	import { Bug, CircleCheck, EyeOff, RotateCcw } from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityToolbar from "#lib/components/entity-toolbar.svelte";
	import ErrorLevelBadge from "#lib/components/error-level-badge.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import type { IssueStatus } from "#lib/error-tracking/event.js";
	import { timeAgo } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import IssueViewsNav from "../issue-views-nav.svelte";

	const { data } = $props();
	const svc = $derived(data.service);

	onMount(() => title.set(`${svc.name} · Errors board`));

	const COLUMNS: Record<
		IssueStatus,
		{ empty: string; icon: typeof Bug; label: string; verb: string }
	> = {
		ignored: {
			empty: "Nothing ignored.",
			icon: EyeOff,
			label: "Ignored",
			verb: "ignored",
		},
		resolved: {
			empty: "Nothing resolved yet.",
			icon: CircleCheck,
			label: "Resolved",
			verb: "resolved",
		},
		unresolved: {
			empty: "No unresolved errors.",
			icon: RotateCcw,
			label: "Unresolved",
			verb: "reopened",
		},
	};

	const sorts = [
		{ label: "Last seen", value: "-lastSeen" },
		{ label: "First seen", value: "-firstSeen" },
		{ label: "Most events", value: "-count" },
	];

	let moveForm = $state<HTMLFormElement | null>(null);
	let moving = $state<{ id: string; status: IssueStatus } | null>(null);
	let dragging = $state<{ id: string; status: IssueStatus } | null>(null);
	let over = $state<IssueStatus | null>(null);

	function issueHref(issueId: string): string {
		return resolve(
			"/(protected)/services/[serviceId]/observability/errors/[issueId]/[[eventId]]",
			{ issueId, serviceId: svc.id },
		);
	}

	function listHref(status: IssueStatus): string {
		return `${resolve("/(protected)/services/[serviceId]/observability/errors", { serviceId: svc.id })}?status=${status}`;
	}

	async function move(id: string, status: IssueStatus) {
		if (moving) {
			return;
		}
		moving = { id, status };
		await tick();
		moveForm?.requestSubmit();
	}

	function onDrop(event: DragEvent, status: IssueStatus) {
		event.preventDefault();
		over = null;
		const card = dragging;
		dragging = null;
		if (card && card.status !== status) {
			move(card.id, status);
		}
	}

	function onDragOver(event: DragEvent, status: IssueStatus) {
		if (dragging && dragging.status !== status) {
			event.preventDefault();
			over = status;
		}
	}
</script>

<div class="space-y-6">
  {#if data.parentId}
    <section class="panel rounded-md p-5">
      <p class="text-text-muted text-sm">
        Previews and canaries report into their parent service's project.
        <a
          class="text-accent hover:underline"
          href={resolve("/(protected)/services/[serviceId]/observability/errors/board", {
            serviceId: data.parentId,
          })}
        >Open the parent's board</a>.
      </p>
    </section>
  {:else if !data.columns}
    <EmptyState
      icon={Bug}
      subtitle="Turn error tracking on from the Errors tab, and the issues this service throws show up here, one column per status."
      title="Error tracking is off"
    >
      {#snippet children()}
        <Button
          href={resolve("/(protected)/services/[serviceId]/observability/errors", {
            serviceId: svc.id,
          })}
          size="sm"
        >Go to Errors</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <IssueViewsNav serviceId={svc.id} />

    <EntityToolbar placeholder="Search issues by title or culprit…" sorts={sorts} />

    <form
      action="?/status"
      class="hidden"
      method="POST"
      bind:this={moveForm}
      use:enhance={enhanceToast({
        error: "Couldn't move the issue.",
        loading: "Moving the issue",
        onSettled: () => {
          moving = null;
        },
        success: (result) => {
          const status = (result as { status?: IssueStatus } | undefined)?.status;
          return status ? `Issue ${COLUMNS[status].verb}.` : "Issue moved.";
        },
      })}
    >
      <input name="issueId" type="hidden" value={moving?.id ?? ""} />
      <input name="status" type="hidden" value={moving?.status ?? ""} />
    </form>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {#each data.columns as column (column.status)}
        {@const meta = COLUMNS[column.status]}
        {@const Icon = meta.icon}
        <section
          aria-label="{meta.label} issues"
          class="panel flex min-h-48 flex-col rounded-md transition-colors {over === column.status
            ? 'ring-accent ring-2'
            : ''}"
          ondragleave={() => {
            if (over === column.status) {
              over = null;
            }
          }}
          ondragover={(event) => onDragOver(event, column.status)}
          ondrop={(event) => onDrop(event, column.status)}
          role="group"
        >
          <header class="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 class="text-text flex items-center gap-2 text-sm font-semibold">
              <Icon class="text-text-muted size-4" />
              {meta.label}
            </h2>
            <span class="text-text-muted text-xs tabular-nums">{column.total}</span>
          </header>

          <ul class="flex flex-1 flex-col gap-2 p-3">
            {#each column.items as issue (issue.id)}
              <li
                class="border-border bg-surface hover:border-text-subtle cursor-grab rounded-md border p-3 transition-opacity active:cursor-grabbing {moving?.id === issue.id
                  ? 'opacity-50'
                  : ''}"
                draggable="true"
                ondragend={() => {
                  dragging = null;
                  over = null;
                }}
                ondragstart={(event) => {
                  event.dataTransfer?.setData("text/plain", issue.id);
                  dragging = { id: issue.id, status: column.status };
                }}
              >
                <div class="flex items-start gap-2">
                  <ErrorLevelBadge level={issue.level} />
                  <a
                    class="text-text min-w-0 flex-1 text-sm font-medium break-words hover:underline"
                    draggable="false"
                    href={issueHref(issue.id)}
                  >{issue.title}</a>
                </div>
                {#if issue.culprit}
                  <p class="text-text-subtle mt-1 truncate font-mono text-xs" title={issue.culprit}>{issue.culprit}</p>
                {/if}
                <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span class="text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span>{issue.count} {issue.count === 1 ? "event" : "events"}</span>
                    {#if issue.usersAffected > 0}
                      <span>{issue.usersAffected} {issue.usersAffected === 1 ? "user" : "users"}</span>
                    {/if}
                    <span title={new Date(issue.lastSeen).toLocaleString()}>{timeAgo(issue.lastSeen)}</span>
                    {#if column.status === "unresolved" && issue.regressedAt}
                      <span class="text-amber-600">regressed</span>
                    {/if}
                  </span>
                  <span class="flex items-center gap-0.5">
                    {#each data.columns.filter((target) => target.status !== column.status) as target (target.status)}
                      {@const TargetIcon = COLUMNS[target.status].icon}
                      <Button
                        aria-label="Move to {COLUMNS[target.status].label}"
                        class="size-7"
                        disabled={moving !== null}
                        onclick={() => move(issue.id, target.status)}
                        size="icon"
                        title="Move to {COLUMNS[target.status].label}"
                        type="button"
                        variant="ghost"
                      >
                        <TargetIcon class="size-3.5" />
                      </Button>
                    {/each}
                  </span>
                </div>
              </li>
            {:else}
              <li class="text-text-subtle flex flex-1 items-center justify-center py-10 text-xs">{meta.empty}</li>
            {/each}
          </ul>

          {#if column.total > column.items.length}
            <a
              class="text-accent border-border border-t px-4 py-2.5 text-xs hover:underline"
              href={listHref(column.status)}
            >Showing {column.items.length} of {column.total}, see them all in the list</a>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>
