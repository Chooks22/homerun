<script lang="ts">
	import { Gauge, PlugZap, RefreshCw } from "@lucide/svelte";
	import { onMount } from "svelte";
	import {
		DESTINATION_TYPE_LABELS,
		describeDestination,
	} from "#lib/backup-destinations.js";
	import BackupDestinationFields from "#lib/components/backup-destination-fields.svelte";
	import CapacityBar from "#lib/components/capacity-bar.svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import { inputClass, labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	const destination = $derived(data.destination);

	onMount(() => title.set("Backup Destination"));

	let submitting = $state(false);
	let testing = $state(false);
	let testResult = $state<{ error: string | null } | null>(null);
	let checking = $state(false);
	let savingThreshold = $state(false);
</script>

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
    <div class="min-w-0">
      <h1 class="text-text text-lg font-semibold tracking-tight">
        {destination.name}
      </h1>
      <p class="text-text-muted mt-1 text-sm break-all">
        {DESTINATION_TYPE_LABELS[destination.type]} ·
        {describeDestination(destination)}
      </p>
    </div>
    <form
      action="?/test"
      method="POST"
      use:enhance={enhanceToast({
        error: "The destination test failed.",
        loading: "Writing a test file to the destination",
        onFailure: (failure) => {
          testResult = { error: String(failure?.error ?? "The test failed.") };
        },
        onSettled: () => {
          testing = false;
        },
        onStart: () => {
          testing = true;
          testResult = null;
        },
        onSuccess: () => {
          testResult = { error: null };
        },
        success: "The destination works.",
      })}
    >
      <Button disabled={testing} type="submit" variant="outline">
        <PlugZap class="size-4" />
        Test destination
      </Button>
    </form>
  </div>

  {#if testResult}
    <div
      class="mb-6 rounded-md border p-4 text-sm {testResult.error
        ? 'border-red-500/40 text-red-500'
        : 'border-emerald-500/40 text-emerald-500'}"
      role="status"
    >
      {#if testResult.error}
        <p class="font-medium">The test failed</p>
        <p class="mt-1 font-mono text-xs break-all whitespace-pre-wrap">{testResult.error}</p>
      {:else}
        <p class="font-medium">
          Reached it, wrote a test file and deleted it again.
        </p>
      {/if}
    </div>
  {/if}

  <div class="mb-6 grid gap-4 lg:grid-cols-2">
    <div class="panel rounded-md p-5">
      <h2 class="text-text text-sm font-semibold">Details</h2>
      <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt class="text-text-muted">Type</dt>
        <dd class="text-text">{DESTINATION_TYPE_LABELS[destination.type]}</dd>
        <dt class="text-text-muted">Address</dt>
        <dd class="text-text break-all">{describeDestination(destination)}</dd>
        <dt class="text-text-muted">Added</dt>
        <dd class="text-text">{timeAgo(destination.createdAt)}</dd>
        <dt class="text-text-muted">Last changed</dt>
        <dd class="text-text">{timeAgo(destination.updatedAt)}</dd>
      </dl>
    </div>
    <div class="panel rounded-md p-5">
      <h2 class="text-text text-sm font-semibold">Volumes backed up here</h2>
      {#if data.volumes.length === 0}
        <p class="text-text-muted mt-3 text-sm">
          No volume uses this destination yet. Pick it from a volume's backup
          settings.
        </p>
      {:else}
        <ul class="mt-3 space-y-2 text-sm">
          {#each data.volumes as volume (volume.id)}
            <li class="flex items-center justify-between gap-3">
              <a
                class="text-accent truncate underline"
                href={resolve("/(protected)/storage/[volumeId]", {
                  volumeId: volume.id,
                })}
              >
                {volume.name}
              </a>
              <span class="text-text-muted shrink-0 text-xs">
                {volume.backupEnabled ? "Scheduled" : "Schedule off"}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  {#if destination.type !== "s3"}
    <section class="panel mb-6 rounded-md">
      <PanelHeader
        description="Checked every hour. Channels subscribed to Backup storage low hear about it once it's fuller than the threshold, and again after it went back under."
        icon={Gauge}
        title="Storage"
      >
        {#snippet trailing()}
          <form
            action="?/checkCapacity"
            method="POST"
            use:enhance={enhanceToast({
              error: "Couldn't read the destination's size.",
              loading: "Measuring the destination",
              onSettled: () => {
                checking = false;
              },
              onStart: () => {
                checking = true;
              },
              success: "Measured.",
            })}
          >
            <Button disabled={checking} size="sm" type="submit" variant="outline">
              <RefreshCw class="size-3.5" />
              Check now
            </Button>
          </form>
          <SaveButton form="capacity-alert" pending={savingThreshold} />
        {/snippet}
      </PanelHeader>
      <div class="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_14rem] md:items-end">
        <CapacityBar
          capacity={destination.capacity}
          checkedAt={destination.capacityCheckedAt}
          error={destination.capacityError}
          thresholdPercent={destination.capacityAlertPercent}
        />
        <form
          id="capacity-alert"
          action="?/setCapacityAlert"
          method="POST"
          use:enhance={enhanceToast({
            error: "Couldn't save the threshold.",
            loading: "Saving the threshold",
            onSettled: () => {
              savingThreshold = false;
            },
            onStart: () => {
              savingThreshold = true;
            },
            success: "Threshold saved.",
          })}
        >
          <label class={labelClass} for="capacityAlertPercent">Alert past (% used)</label>
          <input
            id="capacityAlertPercent"
            class={inputClass}
            max="99"
            min="50"
            name="capacityAlertPercent"
            type="number"
            value={destination.capacityAlertPercent}
          />
        </form>
      </div>
    </section>
  {/if}

  <section class="panel mb-6 rounded-md">
    <PanelHeader title="Repository password" />
    <div class="space-y-2 p-5">
      <CopyBox label="restic password" truncate value={destination.resticPassword} />
      <p class="text-text-muted text-xs">
        Every volume's backups here are restic repositories encrypted with this
        password. Keep a copy outside Homerun: if this instance's database is
        lost, it's the only way to restore them, with restic itself.
      </p>
    </div>
  </section>

  <section class="panel mb-6 rounded-md">
    <PanelHeader title="Settings">
      {#snippet trailing()}
        <SaveButton form="destination-settings" pending={submitting} />
      {/snippet}
    </PanelHeader>
    <form
      id="destination-settings"
      action="?/update"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Check the form for errors.",
        loading: "Saving the destination",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Destination saved.",
      })}
    >
      {#if form?.error && !form.tested}
        <p class="text-sm text-red-500">{form.error}</p>
      {/if}
      <BackupDestinationFields {destination} />
      <div>
        <label class={labelClass} for="backupKeep">Backups to keep per volume</label>
        <input
          id="backupKeep"
          class={inputClass}
          min="1"
          name="backupKeep"
          placeholder="All"
          step="1"
          type="number"
          value={destination.backupKeep ?? ""}
        />
        <p class="text-text-subtle mt-1 text-xs">
          After each successful backup, that volume's older archives here are
          deleted so only this many remain. Empty keeps every one.
        </p>
      </div>
      <p class="text-text-subtle text-xs">
        The test uses the saved settings: save a change before testing it.
      </p>
    </form>
  </section>
</div>
