<script lang="ts">
	import { RotateCcw } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { formatBytes } from "#lib/formatting.js";
	import { getVolumeBackups } from "#lib/remote/backups.remote.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		destinationName: string;
		volumeId: string;
		volumeName: string;
	}

	const { destinationName, volumeId, volumeName }: Props = $props();

	let showBackups = $state(false);
	let restoringKey = $state<string | null>(null);
	let restoreDialogOpen = $state(false);
	let pendingRestoreKey = $state("");
	let pendingRestoreForm: HTMLFormElement | null = null;
	let restoreWipe = $state(false);
	let restoreStopServices = $state(true);

	const backups = $derived(getVolumeBackups(volumeId));
	const restoreDescription = $derived(
		[
			`Queue a restore of "${pendingRestoreKey}" into ${volumeName}?`,
			restoreWipe
				? "Everything currently in the volume is deleted first."
				: "Files in the archive replace what's on disk and anything else is left alone.",
			restoreStopServices
				? "Running services using this volume are stopped for the restore and started again after."
				: "Nothing is stopped : restoring under a running container can leave it with half-old, half-new data.",
		].join(" "),
	);

	function requestRestore(e: MouseEvent, label: string) {
		pendingRestoreForm = (e.currentTarget as HTMLElement).closest("form");
		pendingRestoreKey = label;
		restoreDialogOpen = true;
	}
</script>

<section class="rounded-md panel">
  <PanelHeader title="Restore">
    {#snippet trailing()}
      <Button
        onclick={() => {
          showBackups = true;
          void backups.refresh();
        }}
        size="sm"
        variant="ghost"
      >
        <RotateCcw class="size-3.5" />
        {showBackups ? "Refresh list" : "List backups"}
      </Button>
    {/snippet}
  </PanelHeader>
  <div class="p-5">
    {#if !showBackups}
      <p class="text-text-muted text-sm">
        Unpacks a backup from
        <span class="font-mono text-xs">{destinationName}</span>
        back into this volume, in the background. It shows up in the run log
        below like a backup does.
      </p>
    {:else if backups.error}
      <p class="text-sm text-red-500">
        Couldn't list this bucket : {backups.error.message}
      </p>
    {:else if !backups.current}
      <Skeleton class="h-16 w-full" />
    {:else if backups.current.length === 0}
      <p class="text-text-muted text-sm">
        No backups for this volume in that bucket yet.
      </p>
    {:else}
      <div class="mb-3 grid gap-3 sm:grid-cols-2">
        <CheckBox
          helperText="Delete everything in the volume before unpacking, so files that aren't in the backup don't survive the restore."
          id="restoreWipe"
          label="Wipe the volume first"
          name="restoreWipeToggle"
          bind:checked={restoreWipe}
        />
        <CheckBox
          helperText="Stop the running services that mount this volume for the restore, and start them again after."
          id="restoreStopServices"
          label="Stop services during the restore"
          name="restoreStopServicesToggle"
          bind:checked={restoreStopServices}
        />
      </div>
      <ul class="divide-border divide-y">
        {#each backups.current as backup (backup.key)}
          <li class="flex items-center gap-3 py-2">
            <div class="min-w-0 flex-1">
              <p class="text-text truncate font-mono text-xs" title={backup.key}>{backup.label}</p>
              <p class="text-text-subtle mt-0.5 text-xs">
                {backup.lastModified
                  ? new Date(backup.lastModified).toLocaleString()
                  : "unknown date"}
                · {formatBytes(backup.sizeBytes)}
              </p>
            </div>
            <form
              action="?/restore"
              method="POST"
              use:enhance={enhanceToast({
                error: "Couldn't queue the restore.",
                loading: "Queueing the restore",
                onSettled: () => {
                  restoringKey = null;
                },
                onStart: () => {
                  restoringKey = backup.key;
                },
                success: "Restore queued : it shows up in the run log once it starts.",
              })}
            >
              <input name="key" type="hidden" value={backup.key}>
              <input name="wipe" type="hidden" value={restoreWipe ? "on" : ""}>
              <input
                name="stopServices"
                type="hidden"
                value={restoreStopServices ? "on" : ""}
              >
              <Button
                disabled={restoringKey !== null}
                onclick={(e) => requestRestore(e, backup.label)}
                size="sm"
                type="button"
                variant="outline"
              >
                {#if restoringKey === backup.key}
                  <Spinner />
                  Queueing…
                {:else}
                  Restore
                {/if}
              </Button>
            </form>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<ConfirmDialog
  bind:open={restoreDialogOpen}
  confirmLabel="Restore"
  description={restoreDescription}
  destructive={restoreWipe}
  onConfirm={() => pendingRestoreForm?.requestSubmit()}
  title="Restore this backup?"
/>
