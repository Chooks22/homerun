<script lang="ts">
	import { HardDrive, Plus, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { toast } from "svelte-sonner";
	import { labelClass } from "#lib/components/form-styles.js";
	import NewVolumeFields from "#lib/components/new-volume-fields.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import * as Dialog from "#lib/components/ui/dialog/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import type { CronJobMount } from "#lib/cron-job-script.js";
	import { createStorageVolume } from "#lib/remote/volumes.remote.js";
	import { toastError } from "#lib/toast.js";

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

	let options = $state<VolumeOption[]>(untrack(() => [...volumes]));
	let newVolumeOpen = $state(false);
	let newVolumeKind = $state<"bind" | "volume">("volume");
	let creating = $state(false);

	async function createVolumeCallback(
		form: HTMLFormElement,
	): Promise<VolumeOption> {
		creating = true;
		try {
			const data = new FormData(form);
			const volume = await createStorageVolume({
				description: (data.get("description") as string | null) || null,
				kind: data.get("kind") === "bind" ? "bind" : "volume",
				name: (data.get("name") as string | null) ?? "",
				source: (data.get("source") as string | null) ?? "",
			});
			options.push(volume);
			rows.push({ containerPath: "", readOnly: false, volumeId: volume.id });
			newVolumeOpen = false;
			return volume;
		} finally {
			creating = false;
		}
	}

	function handleCreateVolume(event: SubmitEvent) {
		event.preventDefault();
		return toast.promise(
			createVolumeCallback(event.currentTarget as HTMLFormElement),
			{
				error: (error) => toastError(error, "Couldn't create the volume."),
				loading: "Creating the volume",
				success: (volume) =>
					`Volume ${volume.name} created : set its container path, then save.`,
			},
		);
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Storage volumes mounted into the container, for a cache or data that outlives a run. A volume lives on this host, so a job running on another host can't mount one."
    title="Volumes"
  />
  <div class="space-y-3 p-5">
    {#if options.length === 0}
      <p class="text-text-muted text-sm">
        No storage volumes yet : create one with New volume.
      </p>
    {/if}
    {#each rows as row, i (i)}
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-48 flex-1">
          <label class={labelClass} for="mountVolumeId-{i}">Volume</label>
          <Select.Root type="single" bind:value={row.volumeId}>
            <Select.Trigger class="w-full" id="mountVolumeId-{i}">
              {options.find((volume) => volume.id === row.volumeId)?.name ??
                "Pick a volume"}
            </Select.Trigger>
            <Select.Content>
              {#each options as volume (volume.id)}
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
    <div class="flex items-center gap-4">
      {#if options.length > 0}
        <Button class="h-auto p-0" onclick={addRow} variant="link">
          <Plus class="size-3.5" />
          Add volume
        </Button>
      {/if}
      <Button
        class="h-auto p-0"
        onclick={() => {
          newVolumeOpen = true;
        }}
        variant="link"
      >
        <HardDrive class="size-3.5" />
        New volume
      </Button>
    </div>
  </div>
</section>

<Dialog.Root bind:open={newVolumeOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>New volume</Dialog.Title>
      <Dialog.Description>
        A local storage source, created now and added to this job's volumes.
      </Dialog.Description>
    </Dialog.Header>

    <form class="space-y-5" onsubmit={handleCreateVolume}>
      <NewVolumeFields idPrefix="newVolume-" bind:kind={newVolumeKind} />

      <Dialog.Footer>
        <Button
          onclick={() => {
            newVolumeOpen = false;
          }}
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={creating} type="submit">
          {#if creating}
            <Spinner />
            Creating…
          {:else}
            <Plus class="size-3.5" />
            Create volume
          {/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
