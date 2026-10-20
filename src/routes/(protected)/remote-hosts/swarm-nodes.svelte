<script lang="ts">
	import { Crown, Pencil, Trash2, X } from "@lucide/svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import type { NodeEnrollmentSummary } from "#lib/dto/node-enrollment-dto.js";
	import type { SwarmNodeInfo } from "#lib/services/docker.service.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import NodeLabelsDialog from "./node-labels-dialog.svelte";

	const {
		enrollments,
		nodes,
	}: { enrollments: NodeEnrollmentSummary[]; nodes: SwarmNodeInfo[] } =
		$props();

	let confirmOpen = $state(false);
	let pendingNode = $state("");
	let pendingForm: HTMLFormElement | null = null;
	let labelsOpen = $state(false);
	let labelsNodeId = $state<string | null>(null);
	const labelsNode = $derived(
		nodes.find((node) => node.id === labelsNodeId) ?? null,
	);

	function editLabels(nodeId: string) {
		labelsNodeId = nodeId;
		labelsOpen = true;
	}

	function requestRemove(event: MouseEvent, hostname: string) {
		pendingForm = (event.currentTarget as HTMLElement).closest("form");
		pendingNode = hostname;
		confirmOpen = true;
	}

	function gigabytes(bytes: number): string {
		return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	}

	function roles(enrollment: NodeEnrollmentSummary): string {
		return [
			enrollment.buildServer ? "build server" : null,
			enrollment.swarmNode ? "swarm node" : null,
		]
			.filter(Boolean)
			.join(" + ");
	}
</script>

{#if enrollments.length > 0}
  <section class="mt-10">
    <h2 class="text-text text-sm font-semibold">Waiting to enroll</h2>
    <ul class="border-border divide-border mt-3 divide-y rounded-lg border">
      {#each enrollments as enrollment (enrollment.id)}
        <li class="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <div class="min-w-0">
            <p class="text-text truncate font-medium">
              {enrollment.name ?? "Unnamed server"}
            </p>
            <p class="text-text-subtle text-xs">
              {roles(enrollment)}, expires {new Date(
                enrollment.expiresAt,
              ).toLocaleTimeString()}
            </p>
          </div>
          <form
            action="?/revokeEnrollment"
            method="POST"
            use:enhance={enhanceToast({
              error: "Couldn't revoke the enrollment.",
              loading: "Revoking",
              success: "Enrollment revoked.",
            })}
          >
            <input name="enrollmentId" type="hidden" value={enrollment.id} />
            <Button size="icon-sm" title="Revoke" type="submit" variant="ghost">
              <X class="size-4" />
            </Button>
          </form>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if nodes.length > 0}
  <section class="mt-10">
    <h2 class="text-text text-sm font-semibold">Swarm nodes</h2>
    <p class="text-text-muted mt-1 text-sm">
      The machines swarm services' replicas are scheduled on.
    </p>
    <div class="border-border mt-3 overflow-x-auto rounded-lg border">
      <table class="w-full text-sm">
        <thead class="text-text-subtle text-left text-xs">
          <tr class="border-border border-b">
            <th class="px-4 py-2 font-medium">Node</th>
            <th class="px-4 py-2 font-medium">Role</th>
            <th class="px-4 py-2 font-medium">State</th>
            <th class="px-4 py-2 font-medium">Address</th>
            <th class="px-4 py-2 font-medium">Resources</th>
            <th class="px-4 py-2 font-medium">Labels</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each nodes as node (node.id)}
            <tr class="border-border border-b last:border-0">
              <td class="text-text px-4 py-2 font-medium">
                <span class="flex items-center gap-1.5">
                  {node.hostname}
                  {#if node.leader}
                    <Crown class="size-3.5 text-amber-500" />
                  {/if}
                </span>
              </td>
              <td class="text-text-muted px-4 py-2">{node.role}</td>
              <td class="px-4 py-2">
                <span class="flex items-center gap-1.5">
                  <span
                    class="inline-block size-1.5 rounded-full {node.state === 'ready'
                      ? 'bg-green-500'
                      : 'bg-red-500'}"
                  ></span>
                  <span class="text-text-muted">
                    {node.state}{node.availability === "active"
                      ? ""
                      : `, ${node.availability}`}
                  </span>
                </span>
              </td>
              <td class="text-text-muted px-4 py-2 font-mono text-xs">
                {node.address}
              </td>
              <td class="text-text-muted px-4 py-2 text-xs">
                {node.cpus} CPU, {gigabytes(node.memoryBytes)}, {node.architecture}
              </td>
              <td class="px-4 py-2">
                <div class="flex flex-wrap items-center gap-1">
                  {#each Object.entries(node.labels) as [key, value] (key)}
                    <span
                      class="border-border text-text-muted rounded border px-1.5 py-0.5 font-mono text-xs"
                    >
                      {key}={value}
                    </span>
                  {:else}
                    <span class="text-text-subtle text-xs">None</span>
                  {/each}
                </div>
              </td>
              <td class="px-4 py-2 text-right">
                <div class="flex items-center justify-end gap-1">
                  <Button
                    onclick={() => editLabels(node.id)}
                    size="icon-sm"
                    title="Edit labels"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil class="size-4" />
                  </Button>
                  {#if node.role !== "manager"}
                    <form
                      action="?/removeNode"
                      method="POST"
                      use:enhance={enhanceToast({
                        error: "Couldn't remove the node.",
                        loading: `Removing ${node.hostname}`,
                        success: `${node.hostname} removed from the swarm.`,
                      })}
                    >
                      <input name="nodeId" type="hidden" value={node.id} />
                      <Button
                        class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
                        onclick={(e) => requestRemove(e, node.hostname)}
                        size="icon-sm"
                        title="Remove from the swarm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 class="size-4" />
                      </Button>
                    </form>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<NodeLabelsDialog node={labelsNode} bind:open={labelsOpen} />

<ConfirmDialog
  bind:open={confirmOpen}
  confirmLabel="Remove"
  description={`Remove "${pendingNode}" from the swarm? Its replicas are rescheduled on the other nodes. Run "docker swarm leave" on it afterwards so it stops thinking it's joined.`}
  onConfirm={() => pendingForm?.requestSubmit()}
  title="Remove swarm node"
/>
