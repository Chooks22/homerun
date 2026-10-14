<script lang="ts">
	import { TriangleAlert } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import UiModePicker from "#lib/components/ui-mode-picker.svelte";
	import { getReleaseStatus } from "#lib/remote/self-update.remote.js";
	import { getSetupStatus } from "#lib/remote/setup.remote.js";
	import { RESOURCE_KINDS, RESOURCE_LABELS } from "#lib/resource-thresholds.js";
	import {
		nextPasskeyRpId,
		strandedPasskeyCount,
	} from "#lib/security-policy.js";
	import { enhanceToast, saveToast } from "#lib/toast.js";
	import { DEFAULT_UI_MODE } from "#lib/ui-mode.js";
	import { enhance, type SubmitFunction } from "$app/forms";
	import { page } from "$app/state";
	import ResourceIncidents from "./resource-incidents.svelte";

	const { data } = $props();

	const setup = getSetupStatus();

	const CHANNEL_LABELS = {
		canary: "Canary",
		nightly: "Nightly",
		stable: "Stable",
	} as const;
	let updateChannel = $derived(data.settings.updateChannel ?? "stable");
	let defaultUiMode = $derived<string>(
		data.settings.defaultUiMode ?? DEFAULT_UI_MODE,
	);
	const issuesByField = $derived(setup.current?.issuesByField ?? {});

	const derivedOrigin = $derived(
		data.settings.baseDomain
			? `${data.settings.authOrigin?.startsWith("http://") ? "http" : "https"}://${data.settings.baseDomain}`
			: null,
	);

	const originIsDerived = $derived(
		!data.settings.authOrigin ||
			(!!data.settings.baseDomain &&
				(data.settings.authOrigin === `https://${data.settings.baseDomain}` ||
					data.settings.authOrigin === `http://${data.settings.baseDomain}`)),
	);
	let baseDomainInput = $derived(data.settings.baseDomain ?? "");
	let dashboardUrlInput = $derived(
		originIsDerived ? "" : (data.settings.authOrigin ?? ""),
	);
	const nextRpId = $derived(
		nextPasskeyRpId(baseDomainInput, dashboardUrlInput),
	);
	const stranded = $derived(
		strandedPasskeyCount(data.passkeyRpId, nextRpId, data.passkeyCount),
	);
	let strandDialogOpen = $state(false);
	let strandConfirmed = false;
	let coreForm: HTMLFormElement | undefined = $state();

	const saveCore = saveToast("Core settings");
	const guardedSaveCore: SubmitFunction = (input) => {
		if (stranded > 0 && !strandConfirmed) {
			input.cancel();
			strandDialogOpen = true;
			return;
		}
		strandConfirmed = false;
		return saveCore(input);
	};

	const highlighted = $derived(
		new Set(
			(page.url.searchParams.get("highlight") ?? "").split(",").filter(Boolean),
		),
	);
	function highlightClass(field: string): string {
		return highlighted.has(field) ? "ring-2 ring-amber-400" : "";
	}
	function issueFor(field: string): string | undefined {
		return highlighted.has(field) ? issuesByField[field] : undefined;
	}
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Base domain and the auth-gate check URL."
      title="Core"
    >
      {#snippet trailing()}
        <SaveButton form="core-settings" />
      {/snippet}
    </PanelHeader>
    <form
      id="core-settings"
      bind:this={coreForm}
      action="?/updateCore"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={guardedSaveCore}
    >
      <div>
        <label class={label} for="baseDomain">Base domain</label>
        <Input
          class={highlightClass("baseDomain")}
          id="baseDomain"
          name="baseDomain"
          oninput={(event) => {
            baseDomainInput = event.currentTarget.value;
          }}
          placeholder={data.envDefaults.baseDomain}
          type="text"
          value={data.settings.baseDomain ?? ""}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          A bare hostname, e.g.
          <code class="">example.com</code>
          or
          <code class="">app.example.local</code>
          . Deployed services are routed by Traefik under
          <code class="">&lt;slug&gt;.{data.settings.baseDomain ?? data.envDefaults.baseDomain}</code>
          , so a port here is never part of that : add one only if this dashboard is reached on a port, and it moves to the Dashboard URL below instead of the routing name.
        </p>
        {#if issueFor("baseDomain")}
          <p class="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            ⚠ {issueFor("baseDomain")}
          </p>
        {/if}
      </div>
      <div>
        <label class={label} for="serviceSubdomain">Services subdomain</label>
        <Input
          id="serviceSubdomain"
          name="serviceSubdomain"
          placeholder="none"
          spellcheck="false"
          type="text"
          value={data.settings.serviceSubdomain ?? ""}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          One DNS label, e.g.
          <code class="">apps</code>
          , to give every service's default hostname its own namespace,
          <code class="">&lt;slug&gt;.apps.{data.settings.baseDomain ?? data.envDefaults.baseDomain}</code>
          , the way workstations live under
          <code class="">dev</code>
          . Blank keeps
          <code class="">&lt;slug&gt;.{data.settings.baseDomain ?? data.envDefaults.baseDomain}</code>
          . A service picks up a change on its next deploy.
        </p>
      </div>
      <CheckBox
        checked={data.settings.authOrigin
          ? data.settings.authOrigin.startsWith("https://")
          : true}
        helperText={`Origin: ${
          data.settings.authOrigin ??
          (data.settings.baseDomain
          ? `https://${data.settings.baseDomain}`
          : data.envDefaults.authOrigin ?? "derived per-request until a base domain is set")}`}
        id="useHttps"
        label="Use HTTPS"
        name="useHttps"
      />
      <div>
        <label class={label} for="authOrigin">Dashboard URL</label>
        <Input
          class=""
          id="authOrigin"
          name="authOrigin"
          placeholder={derivedOrigin ??
          data.envDefaults.authOrigin ??
          "https://example.com"}
          oninput={(event) => {
            dashboardUrlInput = event.currentTarget.value;
          }}
          type="text"
          value={originIsDerived ? "" : data.settings.authOrigin ?? ""}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          Where <em>this dashboard</em> is reached, scheme and port included.
          Leave blank to derive it from the base domain above. It's separate
          from the routing name because the two genuinely differ in
          development, where the dashboard runs on a port
          (<code class="">http://localhost:5173</code>) while
          services are routed by Traefik on 443
          (<code class="">dashy.localhost</code>). Single sign-on
          redirect URIs and the per-app login wall both point here.
        </p>
        {#if stranded > 0}
          <p class="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <span>
              This moves the dashboard from <code>{data.passkeyRpId}</code> to
              <code>{nextRpId}</code>, which strands
              {stranded === 1 ? "the 1 registered passkey" : `all ${stranded} registered passkeys`}
              on this instance: a passkey only signs in on the hostname it was
              created on. Everyone affected signs in another way and registers a
              new one from Profile → Security.
            </span>
          </p>
        {/if}
      </div>
      <div>
        <label class={label} for="authCheckUrl">Auth-check URL</label>
        <Input
          id="authCheckUrl"
          name="authCheckUrl"
          placeholder={data.envDefaults.authCheckUrl}
          type="text"
          value={data.settings.authCheckUrl ?? ""}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          What Traefik's forwardAuth middleware calls to gatekeep a "Require
          login" service : must be reachable from inside the Traefik
          container.
        </p>
      </div>
      <CheckBox
        checked={data.settings.authCrossSubdomainCookies ?? false}
        helperText="Widens the session cookie to every subdomain of the base domain"
        id="authCrossSubdomainCookies"
        label="Cross-subdomain cookies"
        name="authCrossSubdomainCookies"
      />
    </form>
  </section>

  <section class="panel rounded-md">
    <PanelHeader title="Interface mode">
      {#snippet description()}
        What every account sees until it picks its own mode from its profile.
        A feature simple mode hides keeps working, and its page stays
        reachable from a link or its address.
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="ui-mode" />
      {/snippet}
    </PanelHeader>
    <form
      id="ui-mode"
      action="?/updateUiMode"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={saveToast("Interface mode")}
    >
      <UiModePicker name="defaultUiMode" bind:value={defaultUiMode} />
    </form>
  </section>

  <section class="panel rounded-md">
    <PanelHeader title="Resource limits">
      {#snippet description()}
        How full the server gets before Homerun says so, checked once a minute.
        A resource that stays past its soft limit for the time below sends a
        <strong>Resource warning</strong>, past its hard one a
        <strong>Resource critical</strong> (and new services are refused until
        it drops back); the disk alerts at once. While it lasts it reminds you,
        and it tells you when it's back to normal. The GPU counts only on a host
        that has one.
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="resource-limits" />
      {/snippet}
    </PanelHeader>
    <form
      id="resource-limits"
      action="?/updateResources"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={saveToast("Resource limits")}
    >
      <div class="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-3 text-sm sm:gap-x-4">
        <span></span>
        <span class={label}>Soft %</span>
        <span class={label}>Hard %</span>
        {#each RESOURCE_KINDS as kind (kind)}
          <span class="text-text">{RESOURCE_LABELS[kind]}</span>
          <Input
            aria-label="{RESOURCE_LABELS[kind]} soft threshold"
            max="100"
            min="1"
            name="{kind}Soft"
            type="number"
            value={data.resourceThresholds[kind].soft}
          />
          <Input
            aria-label="{RESOURCE_LABELS[kind]} hard threshold"
            max="100"
            min="1"
            name="{kind}Hard"
            type="number"
            value={data.resourceThresholds[kind].hard}
          />
        {/each}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1.5">
          <span class={label}>Alert after (seconds past a limit)</span>
          <Input
            max="3600"
            min="0"
            name="sustainSeconds"
            type="number"
            value={data.resourceAlertTiming.sustainSeconds}
          />
        </label>
        <label class="grid gap-1.5">
          <span class={label}>Remind every (minutes, 0 for never)</span>
          <Input
            max="1440"
            min="0"
            name="reminderMinutes"
            type="number"
            value={data.resourceAlertTiming.reminderMinutes}
          />
        </label>
      </div>
    </form>
    <ResourceIncidents incidents={data.resourceIncidents} />
  </section>

  <section class="panel rounded-md">
    <PanelHeader
      description="Which releases the update notice offers."
      title="Release channel"
    >
      {#snippet trailing()}
        <SaveButton form="release-channel" />
      {/snippet}
    </PanelHeader>
    <form
      id="release-channel"
      action="?/updateChannel"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't change the release channel.",
        loading: "Saving the release channel",
        onComplete: () => getReleaseStatus().refresh(),
        onFailure: () => {
          updateChannel = data.settings.updateChannel ?? "stable";
        },
        success: "Release channel saved.",
      })}
    >
      <div>
        <label class={label} for="updateChannel">Channel</label>
        <SelectRoot name="updateChannel" type="single" bind:value={updateChannel}>
          <SelectTrigger id="updateChannel">{CHANNEL_LABELS[updateChannel]}</SelectTrigger>
          <SelectContent>
            <SelectItem label="Stable" value="stable" />
            <SelectItem label="Canary" value="canary" />
            <SelectItem label="Nightly" value="nightly" />
          </SelectContent>
        </SelectRoot>
        <p class="text-text-subtle mt-1.5 text-xs">
          <strong>Canary</strong> offers every build merged to <code>main</code> once it
          passed the end-to-end tests, ahead of the next stable release.
          <strong>Nightly</strong> offers the same builds before those tests run, so it
          can ship a broken one. Switching to a more stable channel doesn't downgrade:
          updates just stop until that channel has a release newer than the one you run.
        </p>
      </div>
    </form>
  </section>
</div>

<ConfirmDialog
  bind:open={strandDialogOpen}
  confirmLabel="Save anyway"
  description={`Saving moves the dashboard to ${nextRpId ?? "a new hostname"}. ${stranded === 1 ? "The 1 registered passkey" : `All ${stranded} registered passkeys`} on this instance will stop working, and anyone who relies on one has to sign in another way and register a new passkey.`}
  onConfirm={() => {
    strandConfirmed = true;
    coreForm?.requestSubmit();
  }}
  title="Strand registered passkeys?"
/>
