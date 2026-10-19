<script lang="ts" module>
	/**
	 * Turns a display name into a DNS-safe service slug: lowercase, runs of
	 * anything but `a-z0-9-` collapsed to one dash, trimmed, capped at 63.
	 */
	export function slugify(value: string): string {
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 63);
	}
</script>

<script lang="ts">
	import { BUILTIN_BUILD_CACHE } from "#lib/build-cache.js";
	import { GitBranch, Server } from "@lucide/svelte";
	import { isBuildMethod } from "#lib/build-methods.js";
	import AdvancedDisclosure from "#lib/components/advanced-disclosure.svelte";
	import GitBuildFields from "#lib/components/git-build-fields.svelte";
	import GitSourceFields from "#lib/components/git-source-fields.svelte";
	import ImageCheckWarning from "#lib/components/image-check-warning.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import RegistryFields from "#lib/components/registry-fields.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import { defaultHostname } from "#lib/service-domains.js";
	import { stackScopedSlug } from "#lib/slug.js";
	import { visibleIn } from "#lib/ui-mode.js";
	import type { DetectedConfig } from "#lib/image-config.js";
	import DetectedConfigPanel from "./detected-config-panel.svelte";
	import type { WizardData } from "./wizard-types";
	import { errorClass, label } from "./field-classes";

	interface Props {
		data: WizardData;
		detected: DetectedConfig | null;
		errors?: Record<string, string[]>;
		hidden: boolean;
		image: string;
		slug: string;
		tag: string;
		values?: Record<string, string>;
	}

	let {
		data,
		detected = $bindable(),
		errors,
		hidden,
		image = $bindable(),
		slug = $bindable(),
		tag = $bindable(),
		values,
	}: Props = $props();

	let name = $derived(values?.name ?? data.template?.name ?? "");
	let slugTouched = $state(false);
	let showRegistry = $derived(!!values?.registryUsername);

	let buildSource = $derived<"image" | "git">(
		(values?.buildSource as "image" | "git" | undefined) ?? "image",
	);
	let registryUrl = $derived(values?.registryUrl ?? "");
	let registryUsername = $derived(values?.registryUsername ?? "");
	let gitUrl = $derived(values?.gitUrl ?? "");
	let gitRef = $derived(values?.gitRef ?? "main");
	let gitProviderId = $derived(values?.gitProviderId ?? "");
	let gitRepo = $derived(values?.gitRepo ?? "");
	let autoDeployOnPush = $derived(values?.autoDeployOnPush === "on");
	let gitBuildMethod = $derived(
		isBuildMethod(values?.gitBuildMethod)
			? values.gitBuildMethod
			: "dockerfile",
	);
	let gitDockerfilePath = $derived(values?.gitDockerfilePath ?? "");
	let gitBakeFile = $derived(values?.gitBakeFile ?? "");
	let gitBuildTarget = $derived(values?.gitBuildTarget ?? "");
	let gitBuildContext = $derived(values?.gitBuildContext ?? "");
	let buildCacheRegistryId = $derived(
		values?.buildCacheRegistryId ??
			(data.builtinCacheRunning ? BUILTIN_BUILD_CACHE : ""),
	);

	function onNameInput() {
		if (!slugTouched) {
			slug = stackScopedSlug(data.stackSlug, slugify(name));
		}
	}

	function sourceButtonClass(active: boolean): string {
		return active
			? "border-accent bg-accent-light text-accent"
			: "border-border text-text-muted hover:bg-surface-2";
	}
</script>

<section class="rounded-md panel" class:hidden>
  <PanelHeader
    description="Name it and point at an image."
    icon={Server}
    title="Basic info"
  />

  <div class="space-y-5 p-5">
    <div>
      <label class={label} for="name">
        Name <span class="text-red-500">*</span>
      </label>
      <Input
        id="name"
        name="name"
        oninput={onNameInput}
        placeholder="My API"
        required
        type="text"
        bind:value={name}
      />
      {#if errors?.name}
        <p class={errorClass}>{errors.name[0]}</p>
      {/if}
    </div>

    <div>
      <label class={label} for="slug">
        Slug <span class="text-red-500">*</span>
      </label>
      <Input
        id="slug"
        maxlength={63}
        name="slug"
        oninput={() => {
          slugTouched = true;
        }}
        pattern="[a-z0-9\-]+"
        placeholder="my-api"
        required
        type="text"
        bind:value={slug}
      />
      <p class="mt-1 text-xs text-text-subtle">
        Routed at
        <span class="text-accent">{defaultHostname(slug || "your-slug", data.stackSlug, data.serviceDomain)}</span>
      </p>
      {#if errors?.slug}
        <p class={errorClass}>{errors.slug[0]}</p>
      {/if}
    </div>

    <div>
      <div class={label}>Deploy from</div>
      <div class="flex gap-2">
        <button
          class="
            flex flex-1 items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium transition-all {sourceButtonClass(
            buildSource === 'image',
            )}
         "
          onclick={() => {
            buildSource = "image";
          }}
          type="button"
        >
          <Server class="size-4" />
          Docker image
        </button>
        <button
          class="
            flex flex-1 items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium transition-all {sourceButtonClass(
            buildSource === 'git',
            )}
         "
          onclick={() => {
            buildSource = "git";
          }}
          type="button"
        >
          <GitBranch class="size-4" />
          Git repository
        </button>
      </div>
      <input name="buildSource" type="hidden" value={buildSource}>
    </div>

    {#if buildSource === "image"}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="sm:col-span-2">
          <label class={label} for="image">
            Image <span class="text-red-500">*</span>
          </label>
          <Input
            id="image"
            name="image"
            placeholder="ghcr.io/acme/api"
            required
            type="text"
            bind:value={image}
          />
          {#if errors?.image}
            <p class={errorClass}>{errors.image[0]}</p>
          {/if}
        </div>
        <div>
          <label class={label} for="tag">Tag</label>
          <Input
            id="tag"
            name="tag"
            placeholder="latest"
            type="text"
            bind:value={tag}
          />
        </div>
      </div>

      <ImageCheckWarning {image} {registryUrl} {registryUsername} {tag} />
    {:else}
      <GitSourceFields
        {errorClass}
        {errors}
        labelClass={label}
        providers={data.connectedGitProviders}
        bind:autoDeployOnPush
        bind:gitProviderId
        bind:gitRef
        bind:gitRepo
        bind:gitUrl
      />
      <AdvancedDisclosure
        collapsible={!visibleIn(data.uiMode, "services/new#build")}
        description="Build method and cache"
      >
        <GitBuildFields
          {errorClass}
          {errors}
          labelClass={label}
          registries={data.buildCacheRegistries}
          bind:gitBuildMethod
          bind:gitDockerfilePath
          bind:gitBakeFile
          bind:gitBuildTarget
          bind:gitBuildContext
          bind:buildCacheRegistryId
        />
      </AdvancedDisclosure>
    {/if}

    <DetectedConfigPanel
      {buildSource}
      {gitBuildContext}
      {gitBuildMethod}
      {gitDockerfilePath}
      {gitProviderId}
      {gitRef}
      {gitRepo}
      {image}
      {registryUrl}
      {registryUsername}
      {tag}
      bind:detected
    />
  </div>
</section>

<RegistryFields
  class="rounded-md panel {hidden ? 'hidden' : ''}"
  labelClass={label}
  urlPlaceholder="ghcr.io (blank = Docker Hub)"
  bind:open={showRegistry}
  bind:registryUrl
  bind:registryUsername
/>
