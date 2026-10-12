<script lang="ts">
	import { Plus, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import type { CronJobMount } from "#lib/cron-job-script.js";

	interface VolumeOption {
		id: string;
		name: string;
	}

	const {
		mounts,
		volumes,
	}: { mounts: CronJobMount[]; volumes: VolumeOption[] } = $props();

	let rows = $state<CronJobMount[]>(
		untrack(() => mounts.map((mount) => ({ ...mount }))),
	);

	function addRow() {
		rows.push({ containerPath: "", readOnly: false, volumeId: "" });
	}

	function removeRow(i: number) {
		rows.splice(i, 1);
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Storage volumes mounted into the container, for a cache or data that outlives a run. A volume lives on this host, so a job running on another host can't mount one."
    title="Volumes"
  />
  <div class="space-y-3 p-5">
    {#if volumes.length === 0}
      <p class="text-text-muted text-sm">
        No storage volumes yet : create one under Volumes first.
      </p>
    {/if}
    {#each rows as row, i (i)}
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-48 flex-1">
          <label class={labelClass} for="mountVolumeId-{i}">Volume</label>
          <Select.Root type="single" bind:value={row.volumeId}>
            <Select.Trigger class="w-full" id="mountVolumeId-{i}">
              {volumes.find((volume) => volume.id === row.volumeId)?.name ??
                "Pick a volume"}
            </Select.Trigger>
            <Select.Content>
              {#each volumes as volume (volume.id)}
                <Select.Item label={volume.name} value={volume.id} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="min-w-48 flex-1">
          <label class={labelClass} for="mountPath-{i}">Container path</label>
          <Input
            id="mountPath-{i}"
            name="mountPath"
            placeholder="/tmp/renovate"
            type="text"
            bind:value={row.containerPath}
          />
        </div>
        <label class="flex h-9 items-center gap-2 text-sm">
          <Checkbox bind:checked={row.readOnly} />
          Read-only
        </label>
        <input name="mountVolumeId" type="hidden" value={row.volumeId}>
        <input name="mountReadOnly" type="hidden" value={row.readOnly ? "1" : "0"}>
        <Button
          aria-label="Remove volume"
          class="shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onclick={() => removeRow(i)}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2 class="size-4" />
        </Button>
      </div>
    {/each}
    {#if volumes.length > 0}
      <Button class="h-auto p-0" onclick={addRow} variant="link">
        <Plus class="size-3.5" />
        Add volume
      </Button>
    {/if}
  </div>
</section>
