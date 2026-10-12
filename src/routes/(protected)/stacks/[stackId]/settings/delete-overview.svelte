<script lang="ts">
	import { AlertTriangle } from "@lucide/svelte";
	import type { StackDeleteOverview } from "#lib/services/service-lifecycle.service.js";

	const {
		deleteVolumes,
		overview,
	}: { deleteVolumes: boolean; overview: StackDeleteOverview } = $props();

	const busyServices = $derived(
		new Set(overview.jobs.map((entry) => entry.serviceId)),
	);
</script>

<div class="space-y-3 text-sm">
  {#if overview.jobs.length > 0}
    <div class="flex gap-2 rounded-md border border-amber-300/60 bg-amber-500/10 p-3 text-amber-700 dark:border-amber-900/50 dark:text-amber-400">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <div>
        <p class="font-medium">Still running in this stack</p>
        <ul class="mt-1 list-disc pl-4 text-xs">
          {#each overview.jobs as entry (entry.id)}
            <li>{entry.title}</li>
          {/each}
        </ul>
        <p class="mt-1 text-xs">
          Force deleting cancels them first. Anything they already started on
          the host may need removing by hand.
        </p>
      </div>
    </div>
  {/if}

  <div>
    <p class="text-text font-medium">
      Services ({overview.services.length})
    </p>
    {#if overview.services.length > 0}
      <ul class="text-text-muted mt-1 list-disc pl-5 text-xs">
        {#each overview.services as service (service.id)}
          <li>
            {service.name}
            {#if busyServices.has(service.id)}
              <span class="text-amber-600 dark:text-amber-400">(busy)</span>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="text-text-subtle mt-1 text-xs">
        Each one's container or swarm service, deployment history, DNS records
        and git webhook go with it, plus the stack's network.
      </p>
    {:else}
      <p class="text-text-subtle mt-1 text-xs">None, only the stack goes.</p>
    {/if}
  </div>

  {#if overview.volumes.length > 0}
    <div>
      <p class="text-text font-medium">
        Volumes only this stack mounts ({overview.volumes.length}),
        {deleteVolumes ? "deleted" : "kept"}
      </p>
      <ul class="text-text-muted mt-1 list-disc pl-5 text-xs">
        {#each overview.volumes as volume (volume.id)}
          <li>
            {volume.name}
            <span class="text-text-subtle">
              {volume.kind === "bind" ? "(bind mount, host directory kept)" : "(named volume)"}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if overview.substacks.length > 0}
    <div>
      <p class="text-text font-medium">
        Substacks ({overview.substacks.length}), kept
      </p>
      <p class="text-text-subtle mt-1 text-xs">
        {overview.substacks.map((substack) => substack.name).join(", ")} move to
        the top level with their services.
      </p>
    </div>
  {/if}
</div>
