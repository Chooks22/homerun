<script lang="ts">
	import { ArchiveRestore, ChevronDown, RotateCcw } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import * as Popover from "#lib/components/ui/popover/index.js";
	import { formatBytes } from "#lib/formatting.js";
	import { getVolumeBackups } from "#lib/remote/backups.remote.js";
	import { RESTORE_MODES, type RestoreMode } from "#lib/restore-modes.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		volume: {
			id: string;
			kind: string;
			name: string;
			s3DestinationId: string | null;
		};
	}

	const { volume }: Props = $props();

	let open = $state(false);
	let confirming = $state(false);
	let key = $state("");
	let label = $state("");
	let mode = $state<RestoreMode>("backupFirst");
	let wipe = $state(false);
	let stopServices = $state(true);
	let form = $state<HTMLFormElement | undefined>();

	const backups = $derived(open ? getVolumeBackups(volume.id) : null);
	const isHostPath = $derived(volume.kind !== "volume");
	const description = $derived(
		mode === "revision"
			? `${label} is restored into a new volume and the service is redeployed with it. ${volume.name} itself isn't touched.`
			: `This overwrites the current data in ${volume.name} with ${label}${mode === "backupFirst" ? ", once a backup of the current data succeeded" : ""}.`,
	);

	/** Opens the restore confirmation for one backup. */
	function requestRestore(backup: { key: string; label: string }) {
		key = backup.key;
		label = backup.label;
		open = false;
		if (isHostPath && mode === "revision") {
			mode = "backupFirst";
		}
		confirming = true;
	}
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        disabled={!volume.s3DestinationId}
        size="sm"
        title={volume.s3DestinationId ? undefined : "Set up backups for this volume first"}
        variant="outline"
      >
        <ArchiveRestore class="size-4" />
        Backups
        <ChevronDown class="size-3.5" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    align="end"
    class="max-h-[min(24rem,70dvh)] w-[min(26rem,calc(100vw-1rem))] gap-0 overflow-y-auto rounded-md p-0"
  >
    <div class="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
      <p class="text-text text-sm font-semibold">Backups of {volume.name}</p>
      <Button
        aria-label="Refresh the list"
        onclick={() => void backups?.refresh()}
        size="icon-sm"
        variant="ghost"
      >
        <RotateCcw class="size-3.5" />
      </Button>
    </div>
    {#if !backups || (!backups.current && !backups.error)}
      <div class="space-y-2 p-4">
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else if backups.error}
      <p class="p-4 text-sm text-red-500">Couldn't list the bucket: {backups.error.message}</p>
    {:else if backups.current?.length === 0}
      <p class="text-text-muted p-4 text-sm">No backups of this volume yet.</p>
    {:else}
      <ul class="divide-border divide-y">
        {#each backups.current ?? [] as backup (backup.key)}
          <li class="flex items-center gap-3 px-4 py-2.5">
            <div class="min-w-0 flex-1">
              <p class="text-text truncate font-mono text-xs" title={backup.key}>{backup.label}</p>
              <p class="text-text-subtle mt-0.5 text-xs">
                {backup.lastModified ? new Date(backup.lastModified).toLocaleString() : "unknown date"}
                · {formatBytes(backup.sizeBytes)}
              </p>
            </div>
            <Button onclick={() => requestRestore(backup)} size="sm" variant="outline">
              Restore
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </Popover.Content>
</Popover.Root>

<form
  action="?/restoreBackup"
  class="hidden"
  method="POST"
  bind:this={form}
  use:enhance={enhanceToast({
    error: "Couldn't queue the restore.",
    loading: "Queueing the restore",
    success: (data) =>
      data && "restoreQueued" in data && typeof data.restoreQueued === "string"
        ? data.restoreQueued
        : "Restore queued.",
  })}
>
  <input name="volumeId" type="hidden" value={volume.id}>
  <input name="key" type="hidden" value={key}>
  <input name="mode" type="hidden" value={mode}>
  <input name="wipe" type="hidden" value={wipe ? "on" : ""}>
  <input name="stopServices" type="hidden" value={stopServices ? "on" : ""}>
  <input name="confirm" type="hidden" value={volume.name}>
</form>

<ConfirmDialog
  confirmLabel="Restore"
  confirmPhrase={volume.name}
  {description}
  destructive={mode !== "revision"}
  onConfirm={() => form?.requestSubmit()}
  title="Restore this backup?"
  bind:open={confirming}
>
  <fieldset class="space-y-2">
    <legend class="text-text-muted mb-1 text-xs font-medium">How</legend>
    {#each RESTORE_MODES as option (option.id)}
      {@const unavailable = option.id === "revision" && isHostPath}
      <label
        class="flex items-start gap-3 rounded-md border p-3 {mode === option.id
          ? 'border-accent bg-accent-light'
          : 'border-border'} {unavailable ? 'opacity-50' : 'cursor-pointer'}"
      >
        <input
          checked={mode === option.id}
          class="mt-0.5"
          disabled={unavailable}
          name="restoreMode"
          onchange={() => {
            mode = option.id;
          }}
          type="radio"
          value={option.id}
        >
        <span class="grid gap-0.5">
          <span class="text-text text-sm font-medium">{option.name}</span>
          <span class="text-text-muted text-xs">
            {unavailable ? "Only for Docker volumes: a host path can't be cloned into a new one." : option.description}
          </span>
        </span>
      </label>
    {/each}
  </fieldset>
  {#if mode !== "revision"}
    <div class="grid gap-2 sm:grid-cols-2">
      <CheckBox
        helperText="Delete everything in the volume first, so files that aren't in the backup don't survive."
        id="restore-wipe-{volume.id}"
        label="Wipe the volume first"
        name="wipeToggle"
        bind:checked={wipe}
      />
      <CheckBox
        helperText="Stop the services using the volume while it's restored, and start them again after."
        id="restore-stop-{volume.id}"
        label="Stop services during the restore"
        name="stopServicesToggle"
        bind:checked={stopServices}
      />
    </div>
  {/if}
</ConfirmDialog>
