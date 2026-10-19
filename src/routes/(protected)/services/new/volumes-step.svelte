<script lang="ts">
	import { HardDrive, Plus, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import { HOST_VOLUME_PREFIX } from "#lib/constants.js";
	import type { DetectedConfig } from "#lib/image-config.js";
	import { getUnknownHostVolumes } from "#lib/remote/docker-infra.remote.js";
	import { dataPathFor } from "#lib/service-link.js";
	import { errorClass, label } from "./field-classes";
	import type { WizardVolume } from "./wizard-types";

	interface Props {
		detected: DetectedConfig | null;
		errors?: Record<string, string[]>;
		hidden: boolean;
		image: string;
		slug: string;
		tag: string;
		templateVolumes?: string[];
		volumes: WizardVolume[];
	}

	const {
		detected,
		errors,
		hidden,
		image,
		slug,
		tag,
		templateVolumes = [],
		volumes,
	}: Props = $props();

	const NEW_VOLUME = "new";

	interface VolumeRow {
		containerPath: string;
		newName: string;
		readOnly: boolean;
		volumeId: string;
	}

	const volumeRows = $state<VolumeRow[]>(
		untrack(() =>
			templateVolumes.map((containerPath) => ({
				containerPath,
				newName: "",
				readOnly: false,
				volumeId: NEW_VOLUME,
			})),
		),
	);
	let defaultRow: VolumeRow | null = null;
	let defaultPath = "";

	$effect(() => {
		const path = dataPathFor(image, tag);
		untrack(() => {
			const untouched =
				defaultRow &&
				volumeRows.includes(defaultRow) &&
				defaultRow.containerPath === defaultPath;
			if (untouched && defaultRow) {
				if (path) {
					defaultRow.containerPath = path;
				} else {
					volumeRows.splice(volumeRows.indexOf(defaultRow), 1);
				}
			} else if (path && volumeRows.length === 0) {
				volumeRows.push({
					containerPath: path,
					newName: "",
					readOnly: false,
					volumeId: NEW_VOLUME,
				});
				defaultRow = volumeRows[0];
			}
			defaultPath = path ?? "";
		});
	});

	let detectedRows: { path: string; row: VolumeRow }[] = [];

	$effect(() => {
		const paths = detected?.volumes ?? [];
		untrack(() => {
			for (const { path, row } of detectedRows) {
				const untouched =
					row.containerPath === path &&
					row.volumeId === NEW_VOLUME &&
					row.newName === "" &&
					!row.readOnly;
				if (untouched && volumeRows.includes(row) && !paths.includes(path)) {
					volumeRows.splice(volumeRows.indexOf(row), 1);
				}
			}
			detectedRows = detectedRows.filter(({ row }) => volumeRows.includes(row));
			for (const path of paths) {
				if (volumeRows.some((row) => row.containerPath === path)) {
					continue;
				}
				volumeRows.push({
					containerPath: path,
					newName: "",
					readOnly: false,
					volumeId: NEW_VOLUME,
				});
				detectedRows.push({ path, row: volumeRows[volumeRows.length - 1] });
			}
		});
	});

	const knownVolumeSources = $derived(
		volumes.filter((v) => v.kind === "volume").map((v) => v.source),
	);
	const unknownHostVolumes = $derived(
		getUnknownHostVolumes(knownVolumeSources),
	);
	const hostVolumes = $derived(unknownHostVolumes.current ?? []);

	function addVolumeRow() {
		volumeRows.push({
			containerPath: "",
			newName: "",
			readOnly: false,
			volumeId: NEW_VOLUME,
		});
	}

	function volumeLabel(id: string): string {
		if (id === NEW_VOLUME) {
			return "New volume";
		}
		if (id.startsWith(HOST_VOLUME_PREFIX)) {
			return id.slice(HOST_VOLUME_PREFIX.length);
		}
		return volumes.find((v) => v.id === id)?.name ?? "Select a volume";
	}
</script>

<section class="rounded-md panel" class:hidden>
  <PanelHeader
    description="Persistent storage mounted into the container. Anything written outside a volume is lost on redeploy."
    icon={HardDrive}
    title="Volumes"
  />

  <div class="space-y-3 p-5">
    {#each volumeRows as row, i}
      <div class="flex flex-wrap items-end gap-3">
        <input name="volumeId" type="hidden" value={row.volumeId}>
        <input name="volumeNewName" type="hidden" value={row.newName}>
        <input
          name="volumeReadOnly"
          type="hidden"
          value={row.readOnly ? "on" : "off"}
        >
        <div class="min-w-48 flex-1">
          <label class={label} for="volumeId-{i}">Volume</label>
          <SelectRoot type="single" bind:value={row.volumeId}>
            <SelectTrigger class="w-full" id="volumeId-{i}">
              {volumeLabel(row.volumeId)}
            </SelectTrigger>
            <SelectContent>
              <SelectItem label="New volume" value={NEW_VOLUME} />
              {#each volumes as vol (vol.id)}
                <SelectItem label={vol.name} value={vol.id} />
              {/each}
              {#if hostVolumes.length > 0}
                <div class="text-text-subtle px-2 py-1.5 text-[0.6875rem] font-medium">
                  On this machine
                </div>
                {#each hostVolumes as hostName (hostName)}
                  <SelectItem
                    label={hostName}
                    value="{HOST_VOLUME_PREFIX}{hostName}"
                  />
                {/each}
              {/if}
            </SelectContent>
          </SelectRoot>
        </div>
        {#if row.volumeId === NEW_VOLUME}
          <div class="min-w-48 flex-1">
            <label class={label} for="volumeNewName-{i}">Volume name</label>
            <Input
              id="volumeNewName-{i}"
              placeholder={i === 0
              ? `${slug || "my-app"}-data`
              : `${slug || "my-app"}-data-${i}`}
              type="text"
              bind:value={row.newName}
            />
          </div>
        {/if}
        <div class="min-w-48 flex-1">
          <label class={label} for="volumeContainerPath-{i}">Mount path</label>
          <Input
            id="volumeContainerPath-{i}"
            name="volumeContainerPath"
            placeholder="/data"
            type="text"
            bind:value={row.containerPath}
          />
        </div>
        <label
          class="flex h-9 items-center gap-2 text-sm text-text"
          for="volumeReadOnly-{i}"
        >
          <Checkbox id="volumeReadOnly-{i}" bind:checked={row.readOnly} />
          Read-only
        </label>
        <Button
          aria-label="Remove"
          class="shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onclick={() => volumeRows.splice(i, 1)}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2 class="size-4" />
        </Button>
      </div>
    {/each}

    {#if volumeRows.length === 0}
      <p class="text-xs text-text-subtle">
        No volumes : fine for stateless apps.
      </p>
    {/if}

    <Button class="h-auto p-0" onclick={addVolumeRow} variant="link">
      <Plus class="size-3.5" />
      Add volume
    </Button>
    {#if errors?.volumes}
      <p class={errorClass}>{errors.volumes[0]}</p>
    {/if}
  </div>
</section>
