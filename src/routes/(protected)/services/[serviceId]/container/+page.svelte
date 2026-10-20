<script lang="ts">
	import { Cpu } from "@lucide/svelte";
	import { onMount } from "svelte";
	import AdvancedDisclosure from "#lib/components/advanced-disclosure.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Switch } from "#lib/components/ui/switch/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { timeAgo } from "#lib/formatting.js";
	import { scaleToZeroLabel } from "#lib/scale-to-zero.js";
	import { title } from "#lib/store/title.js";
	import {
		isDefaultSwarmPlacement,
		swarmPlacementFrom,
	} from "#lib/swarm-placement.js";
	import { enhanceToast } from "#lib/toast.js";
	import { visibleIn } from "#lib/ui-mode.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const svc = $derived(data.service);
	const placement = $derived(swarmPlacementFrom(svc.swarmPlacement));

	onMount(() => title.set(`${svc.name} · Compute`));

	const label = "block mb-1.5 text-sm font-medium text-text";
	const errorClass = "mt-1.5 text-xs text-red-500";

	const values = $derived(
		(form?.values as Record<string, string> | undefined) ?? {
			cpuLimit: svc.cpuLimit ?? "",
			memoryLimitMb: svc.memoryLimitMb ? String(svc.memoryLimitMb) : "",
			placementConstraints: placement.constraints.join("\n"),
			placementManager: placement.roles.includes("manager") ? "on" : "",
			placementPreferences: placement.preferences.join("\n"),
			placementWorker: placement.roles.includes("worker") ? "on" : "",
			replicas: String(svc.replicas ?? 1),
			scaleToZeroEnabled: svc.scaleToZeroMinutes ? "on" : "",
			scaleToZeroMinutes: String(svc.scaleToZeroMinutes ?? 15),
		},
	);
	const errors = $derived(form?.errors as Record<string, string[]> | undefined);

	let submitting = $state(false);
	let scaleToZero = $derived(values.scaleToZeroEnabled === "on");
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Resource limits, replicas and scale to zero. Limits and replicas take effect on the next deploy, scale to zero right away."
    icon={Cpu}
    title="Compute"
  >
    {#snippet trailing()}
      <SaveButton form="compute-settings" pending={submitting} />
    {/snippet}
  </PanelHeader>

  <form
    id="compute-settings"
    action="?/updateCompute"
    class="space-y-5 p-5"
    method="POST"
    use:enhance={enhanceToast({
      error: "Check the form for errors.",
      loading: "Saving compute settings",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Saved.",
    })}
  >
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class={label} for="cpuLimit">CPU limit</label>
        <Input
          id="cpuLimit"
          name="cpuLimit"
          placeholder="e.g. 0.5 (cores)"
          type="text"
          value={values.cpuLimit}
        />
        {#if errors?.cpuLimit}
          <p class={errorClass}>{errors.cpuLimit[0]}</p>
        {/if}
      </div>
      <div>
        <label class={label} for="memoryLimitMb">Memory limit (MB)</label>
        <Input
          id="memoryLimitMb"
          min="1"
          name="memoryLimitMb"
          placeholder="e.g. 512"
          type="number"
          value={values.memoryLimitMb}
        />
        {#if errors?.memoryLimitMb}
          <p class={errorClass}>{errors.memoryLimitMb[0]}</p>
        {/if}
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-text text-sm font-medium">Scale to zero</p>
          <p class="text-text-subtle mt-0.5 text-xs">
            Stops the service after a stretch without requests, and starts it
            again on the next one: that request waits for it to boot. Only
            requests through its domains count, not other services calling
            it over the Docker network. Not for databases, workers or anything
            that has to keep running.
          </p>
        </div>
        <input
          name="scaleToZeroEnabled"
          type="hidden"
          value={scaleToZero ? "on" : ""}
        />
        <Switch
          aria-label="Scale to zero"
          checked={scaleToZero}
          onCheckedChange={(checked) => {
            scaleToZero = checked;
          }}
        />
      </div>
      {#if scaleToZero}
        <div class="max-w-48">
          <label class={label} for="scaleToZeroMinutes">Idle minutes</label>
          <Input
            id="scaleToZeroMinutes"
            max="1440"
            min="1"
            name="scaleToZeroMinutes"
            type="number"
            value={values.scaleToZeroMinutes}
          />
          {#if errors?.scaleToZeroMinutes}
            <p class={errorClass}>{errors.scaleToZeroMinutes[0]}</p>
          {/if}
        </div>
      {/if}
      {#if svc.sleepingSince}
        <p class="text-text-muted text-xs">
          Went to sleep {timeAgo(svc.sleepingSince)}. The next request
          to one of its domains wakes it.
        </p>
      {:else if svc.scaleToZeroMinutes}
        <p class="text-text-muted text-xs">
          {scaleToZeroLabel(svc.scaleToZeroMinutes)}.
        </p>
      {/if}
      {#if scaleToZero && !data.errorPagesPublished}
        <p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
          Traefik's dynamic config directory isn't set (Settings → Networking),
          so nothing could wake the service: it won't be put to sleep until it
          is.
        </p>
      {/if}
      {#if scaleToZero && !svc.dnsResolvable}
        <p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
          This service isn't routed by Traefik, so no request could wake it:
          it won't be put to sleep.
        </p>
      {/if}
    </div>

    {#if data.orchestrationMode === "swarm"}
      <AdvancedDisclosure
        collapsible={!visibleIn(data.uiMode, "service/container#replicas") &&
        (svc.replicas ?? 1) === 1 &&
        isDefaultSwarmPlacement(placement)}
        description="Replicas and placement"
      >
        <div>
          <label class={label} for="replicas">Replicas</label>
          <Input
            id="replicas"
            min="0"
            name="replicas"
            type="number"
            value={values.replicas}
          />
          <p class="mt-1.5 text-xs text-text-subtle">
            Swarm mode only. 0 : same as stopping the service.
          </p>
          {#if errors?.replicas}
            <p class={errorClass}>{errors.replicas[0]}</p>
          {/if}
        </div>

        <div>
          <p class={label}>Node roles</p>
          <div class="flex flex-wrap gap-4">
            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.placementManager === "on"}
                name="placementManager"
              />
              Manager
            </label>
            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.placementWorker === "on"}
                name="placementWorker"
              />
              Worker
            </label>
          </div>
          <p class="mt-1.5 text-xs text-text-subtle">
            Which swarm nodes may run its replicas.
          </p>
          {#if errors?.placementRoles}
            <p class={errorClass}>{errors.placementRoles[0]}</p>
          {/if}
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <div>
            <label class={label} for="placementConstraints">
              Placement constraints
            </label>
            <Textarea
              class="font-mono"
              content={values.placementConstraints}
              id="placementConstraints"
              name="placementConstraints"
              placeholder={"env==staging\ndisk!=hdd"}
              rows={3}
            />
            <p class="mt-1.5 text-xs text-text-subtle">
              One per line, on node labels: <code>key==value</code> or
              <code>key!=value</code>. Every one has to match.
            </p>
            {#if errors?.placementConstraints}
              <p class={errorClass}>{errors.placementConstraints[0]}</p>
            {/if}
          </div>
          <div>
            <label class={label} for="placementPreferences">
              Spread across
            </label>
            <Textarea
              class="font-mono"
              content={values.placementPreferences}
              id="placementPreferences"
              name="placementPreferences"
              placeholder="zone"
              rows={3}
            />
            <p class="mt-1.5 text-xs text-text-subtle">
              Node label keys, one per line: replicas are spread evenly over
              that label's values, in order.
            </p>
            {#if errors?.placementPreferences}
              <p class={errorClass}>{errors.placementPreferences[0]}</p>
            {/if}
          </div>
        </div>
        <p class="text-xs text-text-subtle">
          Node labels are set on Remote Hosts → Swarm nodes. A replica no node
          satisfies stays pending.
        </p>
      </AdvancedDisclosure>
    {/if}
  </form>
</section>
