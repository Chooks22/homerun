<script lang="ts">
	import { Pin, PinOff, RefreshCw } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import ResponsiveDialog from "#lib/components/responsive-dialog.svelte";
	import RunStatusBadge from "#lib/components/run-status-badge.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import {
		isPinnableTag,
		type PinCandidates,
		parseVersionTag,
	} from "#lib/image-versions.js";
	import type { Service } from "#lib/server/db/schema.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { refreshAll } from "$app/navigation";

	interface Props {
		labelClass: string;
		service: Pick<
			Service,
			| "image"
			| "pinnedFromTag"
			| "pinnedLocally"
			| "tag"
			| "updateCheck"
			| "updateCheckEnabled"
			| "updateTrialEnabled"
		>;
	}

	const { labelClass, service }: Props = $props();

	const TRIAL_POLL_MS = 5000;

	let candidates = $state<PinCandidates | null>(null);
	let dialogOpen = $state(false);
	let choice = $state("");
	let localTag = $state("");
	let pinning = $state(false);
	let pinForm = $state<HTMLFormElement | null>(null);
	let watchSaving = $state(false);
	let updateCheckEnabled = $derived(service.updateCheckEnabled);
	let updateTrialEnabled = $derived(service.updateTrialEnabled);

	const check = $derived(service.updateCheck);
	const trial = $derived(check?.trial ?? null);
	const shortDigest = $derived(
		candidates?.digest?.replace("sha256:", "").slice(0, 12) ?? null,
	);

	$effect(() => {
		if (trial?.status !== "running") {
			return;
		}
		const timer = setInterval(() => refreshAll(), TRIAL_POLL_MS);
		return () => clearInterval(timer);
	});

	function openPinDialog(found: PinCandidates) {
		candidates = found;
		localTag = found.suggestion;
		choice = found.matches.find(isPinnableTag) ?? "local";
		dialogOpen = true;
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Pin a floating tag to the release it's running, and hear about newer ones."
    icon={Pin}
    title="Version"
  >
    {#snippet trailing()}
      {#if service.pinnedFromTag}
        <form
          action="?/unpin"
          method="POST"
          use:enhance={enhanceToast({
            loading: "Unpinning",
            success: (data) => `Back on :${String(data?.tag ?? "")}. Redeploy to pull it.`,
          })}
        >
          <Button size="sm" type="submit" variant="outline">
            <PinOff class="size-4" />
            Unpin
          </Button>
        </form>
      {:else}
        <form
          action="?/findPin"
          method="POST"
          use:enhance={enhanceToast({
            loading: "Looking up the running image's tags",
            onSettled: () => {
              pinning = false;
            },
            onStart: () => {
              pinning = true;
            },
            onSuccess: (data) => {
              if (data?.pin) {
                openPinDialog(data.pin as PinCandidates);
              }
            },
            success: "Looked up.",
          })}
        >
          <Button loading={pinning} size="sm" type="submit">
            <Pin class="size-4" />
            Pin version
          </Button>
        </form>
      {/if}
    {/snippet}
  </PanelHeader>

  <div class="space-y-5 p-5">
    <div class="text-sm">
      <span class="text-text-muted">Deploys</span>
      <code class="font-mono">{service.image}:{service.tag}</code>
      {#if service.pinnedFromTag}
        <span class="text-text-muted">
          · pinned from <code class="font-mono">:{service.pinnedFromTag}</code>{service.pinnedLocally ? ", tagged on this host" : ""}
        </span>
      {/if}
    </div>

    <form
      id="update-watch"
      action="?/updateWatch"
      class="space-y-3"
      method="POST"
      use:enhance={enhanceToast({
        loading: "Saving update checks",
        onSettled: () => {
          watchSaving = false;
        },
        onStart: () => {
          watchSaving = true;
        },
        success: "Update checks saved.",
      })}
    >
      <CheckBox
        helperText="Checks the registry every 6 hours for a newer stable release on the same track (a nightly-based pin waits for its release), or a new image behind a floating tag, and sends an Update available notification."
        id="updateCheckEnabled"
        label="Watch for updates"
        name="updateCheckEnabled"
        bind:checked={updateCheckEnabled}
      />
      {#if updateCheckEnabled}
        <CheckBox
          helperText="Starts the new version in a throwaway container first, with this service's environment but no volumes, no ports and no access to its networks, and reports whether it came up. An app that can't start without its database or data will fail this, turn it off for those."
          id="updateTrialEnabled"
          label="Try new versions before notifying"
          name="updateTrialEnabled"
          bind:checked={updateTrialEnabled}
        />
      {:else}
        <input name="updateTrialEnabled" type="hidden" value={updateTrialEnabled ? "on" : ""} />
      {/if}
      <div class="flex justify-end">
        <SaveButton form="update-watch" pending={watchSaving} />
      </div>
    </form>

    {#if service.updateCheckEnabled && check}
      <div class="border-border space-y-3 rounded-md border p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 grow text-sm">
            {#if check.available}
              <div class="font-medium">
                {check.available.tag === service.tag
                  ? `A newer :${check.available.tag} image is out`
                  : `Update available: :${check.available.tag}`}
              </div>
            {:else}
              <div class="font-medium">Up to date</div>
            {/if}
            <div class="text-text-muted text-xs">
              Checked {timeAgo(check.checkedAt)}
            </div>
          </div>
          <form
            action="?/checkUpdates"
            method="POST"
            use:enhance={enhanceToast({
              loading: "Checking the registry",
              success: (data) =>
                data?.available ? `Found :${String(data.available)}.` : "No update found.",
            })}
          >
            <Button size="sm" type="submit" variant="outline">
              <RefreshCw class="size-4" />
              Check now
            </Button>
          </form>
          {#if check.available}
            <form
              action="?/applyUpdate"
              method="POST"
              use:enhance={enhanceToast({
                loading: "Queuing the update",
                success: (data) => `Deploying :${String(data?.tag ?? "")}.`,
              })}
            >
              <Button disabled={trial?.status === "running"} size="sm" type="submit">
                Update now
              </Button>
            </form>
          {/if}
        </div>
        {#if check.error}
          <p class="text-xs text-red-500">{check.error}</p>
        {/if}
        {#if check.available && trial}
          <div class="space-y-2">
            <div class="flex items-center gap-2 text-xs">
              <span class="text-text-muted">Trial run of :{trial.tag}</span>
              <RunStatusBadge
                error={trial.message}
                success={trial.status === "running" ? null : trial.status === "passed"}
              />
              {#if trial.status === "passed" && trial.message}
                <span class="text-text-muted">{trial.message}</span>
              {/if}
            </div>
            {#if trial.status === "failed" && trial.message}
              <pre class="bg-surface-2 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">{trial.message}</pre>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<form
  bind:this={pinForm}
  id="pin-version"
  action="?/pin"
  class="hidden"
  method="POST"
  use:enhance={enhanceToast({
    loading: "Pinning",
    onSuccess: () => {
      dialogOpen = false;
    },
    success: (data) => `Pinned to :${String(data?.tag ?? "")}.`,
  })}
></form>

<ResponsiveDialog
  description={candidates?.matches.length
    ? "The running image is published under these tags. Pick one to pin to."
    : `No published tag points at the running image${shortDigest ? ` (${shortDigest})` : ""}. Tag it on this host instead?`}
  onsubmit={() => pinForm?.requestSubmit()}
  size="sm"
  submitDisabled={choice === "" || (choice === "local" && localTag.trim() === "")}
  submitLabel="Pin"
  title="Pin version"
  bind:open={dialogOpen}
>
  <div class="space-y-3">
    {#if candidates?.matches.length}
      {#each candidates.matches as match (match)}
        <label class="flex items-center gap-2 text-sm">
          <input form="pin-version" name="choice" type="radio" value={match} bind:group={choice} />
          <code class="font-mono">{service.image}:{match}</code>
          {#if !isPinnableTag(match)}
            <span class="text-text-muted text-xs">moves, not a real pin</span>
          {/if}
        </label>
      {/each}
      <label class="flex items-center gap-2 text-sm">
        <input form="pin-version" name="choice" type="radio" value="local" bind:group={choice} />
        None of these, tag it on this host
      </label>
    {:else}
      <input form="pin-version" name="choice" type="hidden" value="local" />
    {/if}
    {#if choice === "local"}
      <div>
        <label class={labelClass} for="localTag">Tag</label>
        <Input
          id="localTag"
          form="pin-version"
          name="localTag"
          type="text"
          bind:value={localTag}
        />
        {#if localTag.trim() && !parseVersionTag(localTag.trim())}
          <p class="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            This tag has no version in it, so update checks can't tell when a release catches up. Start it with the version the build is ahead of, like <code class="font-mono">1.26.0-dev</code>.
          </p>
        {/if}
        <p class="text-text-subtle mt-1.5 text-xs">
          The running image is tagged <code class="font-mono">{service.image}:{localTag || "…"}</code> on this host only, and the pull policy moves to "If missing" so deploys don't look for it on the registry. Start the tag with the version it's ahead of (<code class="font-mono">1.25.0-dev</code>) and update checks will spot that release.
        </p>
      </div>
    {/if}
  </div>
</ResponsiveDialog>
