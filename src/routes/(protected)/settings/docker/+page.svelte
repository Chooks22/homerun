<script lang="ts">
	import { onMount, untrack } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
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
	import { BLOCK_SEVERITY_OPTIONS } from "#lib/image-scan.js";
	import { getSetupStatus } from "#lib/remote/setup.remote.js";
	import {
		MAX_RETAINED_IMAGES,
		MIN_RETAINED_IMAGES,
		RETAINED_REVISIONS,
	} from "#lib/revisions.js";
	import { enhanceToast, saveToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";
	import BuildServersPanel from "./build-servers-panel.svelte";

	const { data } = $props();

	const setup = getSetupStatus();
	const issuesByField = $derived(setup.current?.issuesByField ?? {});

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

	onMount(() => {
		const [first] = highlighted;
		if (first) {
			document
				.getElementById(first)
				?.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	});

	let orchestrationMode = $state(
		untrack(() => data.settings.orchestrationMode ?? "standalone"),
	);

	let blockSeverity = $state<string>(
		untrack(() => data.settings.imageScanBlockSeverity ?? "off"),
	);
	const blockOption = $derived(
		BLOCK_SEVERITY_OPTIONS.find((option) => option.value === blockSeverity) ??
			BLOCK_SEVERITY_OPTIONS[0],
	);
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader title="Docker">
      {#snippet description()}
        The default local connection : separate from the per-service "Deploy
        target" picker on Remote Hosts.
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="docker-connection" />
      {/snippet}
    </PanelHeader>
    <form
      id="docker-connection"
      action="?/updateDocker"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={saveToast("Docker settings")}
    >
      <div>
        <label class={label} for="dockerSocketPath">Socket path</label>
        <Input
          class={highlightClass('dockerSocketPath')}
          id="dockerSocketPath"
          name="dockerSocketPath"
          placeholder={data.envDefaults.dockerSocketPath}
          type="text"
          value={data.settings.dockerSocketPath ?? ""}
        />
        {#if issueFor("dockerSocketPath")}
          <p class="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            ⚠ {issueFor("dockerSocketPath")}
          </p>
        {/if}
      </div>
      <div>
        <label class={label} for="dockerNetworkName"
        >Shared network name</label>
        <Input
          class=""
          id="dockerNetworkName"
          name="dockerNetworkName"
          placeholder={data.envDefaults.dockerNetworkName}
          type="text"
          value={data.settings.dockerNetworkName ?? ""}
        />
      </div>
    </form>
  </section>

  <section class="panel rounded-md">
    <PanelHeader title="Image scanning">
      {#snippet description()}
        Every deploy copies the image into a Homerun-managed registry mirror (
        <code>homerun-mirror</code>
        , published on
        <code>127.0.0.1:5055</code>
        only), scans it there with Trivy, and only then pulls it onto this host. If the mirror can't be used the deploy pulls directly and scans the local image instead. Git builds are scanned once built. Each service can opt out on its own Settings tab. The mirror is garbage-collected daily; its size and a manual cleanup are on
        <a class="underline" href={resolve('docker-cleanup')}>Docker Cleanup</a>
        .
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="image-scanning" />
      {/snippet}
    </PanelHeader>
    <form
      id="image-scanning"
      action="?/updateImageScan"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={saveToast("Image scanning settings")}
    >
      <CheckBox
        checked={data.settings.imageScanEnabled ?? true}
        helperText="Turning this off skips the mirror and the scan for every service."
        id="imageScanEnabled"
        label="Scan images before deploying"
        name="imageScanEnabled"
      />
      <div>
        <label class={label} for="imageScanBlockSeverity"
        >Block deploys at severity</label>
        <SelectRoot
          name="imageScanBlockSeverity"
          type="single"
          bind:value={blockSeverity}
        >
          <SelectTrigger id="imageScanBlockSeverity">
            {blockOption.label}
          </SelectTrigger>
          <SelectContent>
            {#each BLOCK_SEVERITY_OPTIONS as option (option.value)}
              <SelectItem label={option.label} value={option.value} />
            {/each}
          </SelectContent>
        </SelectRoot>
        <p class="text-text-subtle mt-1.5 text-xs">
          {blockOption.description} Applies to manual, scheduled, push-triggered
          and API deploys; a blocked deploy is marked failed, the previous
          container keeps running, and deploy-failure notifications fire.
          Rollbacks to an earlier revision aren't re-checked.
        </p>
      </div>
      <CheckBox
        checked={data.settings.imageScanBlockFixableOnly ?? false}
        helperText="Only count findings that have a fixed version. A vulnerability with no upstream fix yet is still shown on the Security tab, but doesn't block."
        id="imageScanBlockFixableOnly"
        label="Only block on fixable vulnerabilities"
        name="imageScanBlockFixableOnly"
      />
      <CheckBox
        checked={data.settings.imageScanRequired ?? false}
        helperText="When the scanner can't run at all (Trivy can't start, the vulnerability database can't be downloaded, the image can't be read), fail the deploy instead of deploying the unscanned image. The previous container keeps running. Services that opted out of scanning aren't affected."
        id="imageScanRequired"
        label="Fail deploys when the image can't be scanned"
        name="imageScanRequired"
      />
    </form>
  </section>

  <section class="panel rounded-md">
    <PanelHeader title="Retained images">
      {#snippet description()}
        How many distinct images of every service stay on this host for
        rollbacks. Docker Cleanup's image prune and the image mirror cleanup
        skip them, so deploying any of those revisions never needs a rebuild or
        a pull.
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="retained-images" />
      {/snippet}
    </PanelHeader>
    <form
      id="retained-images"
      action="?/updateRetainedImages"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={saveToast("Retained images settings")}
    >
      <div>
        <label class={label} for="retainedImagesPerService"
        >Images kept per service</label>
        <Input
          id="retainedImagesPerService"
          max={MAX_RETAINED_IMAGES}
          min={MIN_RETAINED_IMAGES}
          name="retainedImagesPerService"
          required
          type="number"
          value={data.settings.retainedImagesPerService ?? RETAINED_REVISIONS}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          Between {MIN_RETAINED_IMAGES} and {MAX_RETAINED_IMAGES}. Lowering it
          lets the next cleanup remove the older images.
        </p>
      </div>
    </form>
  </section>

  <BuildServersPanel
    buildConcurrency={data.settings.buildConcurrency ?? 0}
    buildOnHost={data.settings.buildOnHost ?? true}
    defaultBuildServer={data.settings.defaultBuildServer ?? ""}
    servers={data.buildServers}
  />

  <section class="panel rounded-md">
    <PanelHeader title="Orchestration">
      {#snippet description()}
        "Swarm" (what the installer sets up) deploys every service as a
        replicated, self-healing Docker Swarm service : scale via the Replicas
        field on a service's Compute tab, restarts are rolling updates, and
        other machines can join as workers. "Standalone" is a single container
        per service. Saving <strong>Swarm</strong> prepares this host for it :
        <code>docker swarm init</code> if the daemon isn't a manager yet, an
        attachable overlay network (<code>{data.settings.dockerNetworkName
        ?? data.envDefaults.dockerNetworkName}-swarm</code>, since the shared
        bridge network can't be converted in place), Traefik attached to it,
        and Traefik's swarm provider turned on. That last step recreates the
        Traefik container, so this page may blink if you reach it through
        Traefik. Switching back turns the provider off again and leaves the
        swarm itself alone. Either way the mode only changes once the host is
        ready. Services keep running under the old mode until they're
        redeployed.
      {/snippet}
      {#snippet trailing()}
        <SaveButton form="orchestration" />
      {/snippet}
    </PanelHeader>
    <form
      id="orchestration"
      action="?/updateOrchestration"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't apply the orchestration mode.",
        loading: "Applying the orchestration mode",
        onFailure: () => {
          orchestrationMode = data.settings.orchestrationMode ?? "standalone";
        },
        success: (data) =>
          (data?.orchestrationSteps as string[] | undefined)?.at(-1) ??
          "Orchestration settings saved.",
      })}
    >
      {#if data.swarmUnavailableReason}
        <Alert title="Swarm isn't available on this daemon" variant="warning">
          {data.swarmUnavailableReason}
        </Alert>
      {/if}
      <div>
        <label class={label} for="orchestrationMode">Mode</label>
        <SelectRoot
          name="orchestrationMode"
          type="single"
          bind:value={orchestrationMode}
        >
          <SelectTrigger id="orchestrationMode">
            {orchestrationMode === "swarm" ? "Swarm" : "Standalone"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem label="Standalone" value="standalone" />
            <SelectItem
              disabled={Boolean(data.swarmUnavailableReason)}
              label={data.swarmUnavailableReason
              ? "Swarm (needs rootful Docker)"
              : "Swarm"}
              value="swarm"
            />
          </SelectContent>
        </SelectRoot>
      </div>
      <div class="text-text-subtle space-y-1 text-xs">
        <p class="text-text-muted font-medium">What swarm mode doesn't do</p>
        <ul class="list-disc space-y-1 pl-4">
          <li>Privileged mode and device mappings (Runtime tab) are ignored : the swarm API has neither.</li>

          <li>
            Services don't join their stack's own network : every swarm service shares the
            <code>-swarm</code>
            overlay and is reached at its slug.
          </li>
          <li>
            The Terminal tab, pre-backup commands and per-replica stats only reach replicas on this host, and the "from the network" uptime probe doesn't run (the hostname probe does).
          </li>
          <li>
            With more than one node, volumes are per node and an image built on this host needs a build cache registry for other nodes to pull it.
          </li>
        </ul>
      </div>
    </form>
  </section>

</div>
