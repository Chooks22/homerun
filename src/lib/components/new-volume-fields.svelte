<script lang="ts">
	import { Input } from "#lib/components/ui/input/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { slugify } from "#lib/slug.js";

	let {
		idPrefix = "",
		kind = $bindable("volume"),
	}: {
		/** Prefixes the inputs' ids, for a page whose own form already uses `name` or `description`. */
		idPrefix?: string;
		kind?: "bind" | "volume";
	} = $props();

	let name = $state("");
	let source = $state("");
	let sourceEdited = $state(false);

	const suggested = $derived(
		slugify(name)
			? kind === "bind"
				? `/mnt/data/${slugify(name)}`
				: `homerun-${slugify(name)}`
			: "",
	);

	$effect(() => {
		if (!sourceEdited) {
			source = suggested;
		}
	});

	const label = "block mb-1.5 text-sm font-medium text-text";
</script>

<!--
  Just the form fields : no <form> tag of its own, so each consumer wraps
  it in their own <form action=...> with their own use:enhance behavior
  (a full-page create-then-redirect on /storage/new, an in-place
  create-then-refresh in a modal on a service's Volumes tab). Same
  "shared chrome, not shared shape" split as $lib/server/form-styles.ts.
-->
<div>
  <label class={label} for="{idPrefix}name">
    Name <span class="text-red-500">*</span>
  </label>
  <Input
    id="{idPrefix}name"
    name="name"
    placeholder="e.g. Media library"
    required
    type="text"
    bind:value={name}
  />
</div>

<div>
  <p class={label}>Type</p>
  <div class="grid grid-cols-2 gap-3">
    <label
      class="
        flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-all {kind ===
        'volume'
        ? 'border-accent bg-accent-light text-accent'
        : 'border-border text-text-muted'}
     "
    >
      <input
        class="sr-only"
        name="kind"
        type="radio"
        value="volume"
        bind:group={kind}
      >
      Docker volume
    </label>
    <label
      class="
        flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-all {kind ===
        'bind'
        ? 'border-accent bg-accent-light text-accent'
        : 'border-border text-text-muted'}
     "
    >
      <input
        class="sr-only"
        name="kind"
        type="radio"
        value="bind"
        bind:group={kind}
      >
      Host path
    </label>
  </div>
</div>

<div>
  <label class={label} for="{idPrefix}source">
    {kind === "bind" ? "Host path" : "Volume name"}
    <span class="text-red-500">*</span>
  </label>
  <Input
    class=""
    id="{idPrefix}source"
    name="source"
    oninput={() => {
      sourceEdited = source !== "";
    }}
    placeholder={kind === "bind" ? "/mnt/data/media" : "homerun-media"}
    required
    type="text"
    bind:value={source}
  />
  <p class="text-text-subtle mt-1 text-xs">
    {#if kind === "bind"}
      An absolute directory on this host : created automatically if it doesn't
      exist. Filled in from the name until you change it.
    {:else}
      A Docker-managed named volume : created automatically on first use.
      Filled in from the name until you change it.
    {/if}
  </p>
</div>

<div>
  <label class={label} for="{idPrefix}description">Description</label>
  <Textarea
    class="resize-none"
    id="{idPrefix}description"
    name="description"
    placeholder="Optional"
    rows={2}
  />
</div>
