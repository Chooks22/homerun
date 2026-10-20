<script lang="ts">
	import { ScanSearch } from "@lucide/svelte";
	import type { BuildMethod } from "#lib/build-methods.js";
	import {
		type DetectedConfig,
		detectedFrom,
		hasDetected,
	} from "#lib/image-config.js";
	import {
		detectRepoConfig,
		inspectImageConfig,
	} from "#lib/remote/image-check.remote.js";

	const DEBOUNCE_MS = 600;

	interface Props {
		buildSource: "git" | "image";
		detected: DetectedConfig | null;
		gitBuildContext: string;
		gitBuildMethod: BuildMethod;
		gitDockerfilePath: string;
		gitRef: string;
		gitUrl: string;
		image: string;
		registryUrl: string;
		registryUsername: string;
		tag: string;
	}

	let {
		buildSource,
		detected = $bindable(),
		gitBuildContext,
		gitBuildMethod,
		gitDockerfilePath,
		gitRef,
		gitUrl,
		image,
		registryUrl,
		registryUsername,
		tag,
	}: Props = $props();

	let loading = $state(false);

	/** The lookup the current form state calls for, or null when there's nothing to inspect. */
	function lookup(): (() => Promise<DetectedConfig | null>) | null {
		if (buildSource === "image") {
			const args = { image, registryUrl, registryUsername, tag };
			return image.trim() ? () => inspectImageConfig(args) : null;
		}
		if (!(gitUrl.trim() && gitRef.trim())) {
			return null;
		}
		const args = {
			context: gitBuildContext,
			dockerfilePath: gitDockerfilePath,
			gitUrl,
			method: gitBuildMethod,
			ref: gitRef,
		};
		return () => detectRepoConfig(args);
	}

	$effect(() => {
		const run = lookup();
		if (!run) {
			detected = null;
			loading = false;
			return;
		}
		let cancelled = false;
		const timer = setTimeout(async () => {
			loading = true;
			const result = await run().catch(() => null);
			if (!cancelled) {
				detected = result;
				loading = false;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	const facts = $derived.by(() => {
		if (!hasDetected(detected)) {
			return [];
		}
		const rows: { label: string; value: string }[] = [];
		if (detected.ports.length > 0) {
			rows.push({
				label: "Ports",
				value: detected.ports.map((p) => `${p.port}/${p.protocol}`).join(", "),
			});
		}
		if (detected.volumes.length > 0) {
			rows.push({ label: "Volumes", value: detected.volumes.join(", ") });
		}
		const envKeys = Object.keys(detected.env);
		if (envKeys.length > 0) {
			rows.push({ label: "Env", value: envKeys.join(", ") });
		}
		if (detected.healthcheck) {
			rows.push({
				label: "Healthcheck",
				value:
					detected.healthcheck === "NONE" ? "disabled" : detected.healthcheck,
			});
		}
		if (detected.user) {
			rows.push({ label: "User", value: detected.user });
		}
		if (detected.workdir) {
			rows.push({ label: "Workdir", value: detected.workdir });
		}
		if (detected.entrypoint) {
			rows.push({ label: "Entrypoint", value: detected.entrypoint.join(" ") });
		}
		if (detected.command) {
			rows.push({ label: "Command", value: detected.command.join(" ") });
		}
		if (detected.manifest?.keys.length) {
			rows.push({
				label: "On deploy",
				value: detected.manifest.keys.join(", "),
			});
		}
		return rows;
	});
</script>

{#if loading && !detected}
  <p class="text-xs text-text-subtle">
    {buildSource === "image" ? "Reading the image's config…" : "Reading the repository…"}
  </p>
{:else if facts.length > 0}
  <div class="rounded-md border border-border bg-surface-2 p-3 text-xs">
    <p class="flex items-center gap-1.5 font-medium text-text">
      <ScanSearch class="size-3.5" />
      Detected from {detected ? detectedFrom(detected) : ""}
    </p>
    {#if detected?.manifest?.errors.length}
      <div class="mt-2 text-amber-700 dark:text-amber-400">
        {detected.manifest.path} isn't a valid Homerun Manifest, so deploys
        will fail until it's fixed:
        <ul class="ml-4 list-disc">
          {#each detected.manifest.errors as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {#each facts as fact (fact.label)}
        <dt class="text-text-muted">{fact.label}</dt>
        <dd class="font-mono break-all text-text">{fact.value}</dd>
      {/each}
    </dl>
    <p class="mt-2 text-text-subtle">
      The port and volumes are filled in on their steps, and the env can be
      imported on the Environment step.
      {#if detected?.manifest}
        {detected.manifest.path} is applied again on every deploy and wins
        for the keys it sets.
      {:else}
        The rest already applies from the image; override any of it on the
        service's tabs.
      {/if}
    </p>
  </div>
{/if}
