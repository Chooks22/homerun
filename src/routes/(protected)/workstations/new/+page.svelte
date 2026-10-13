<script lang="ts">
	import { Check, Layers } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationFields from "#lib/components/workstation-fields.svelte";
	import { workstationDomainOwner } from "#lib/remote/workstations.remote.js";
	import { slugify } from "#lib/slug.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import {
		DEFAULT_WORKSTATION_FIELDS,
		defaultWorkstationDomain,
	} from "#lib/workstations.js";
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set("New Workstation"));

	let submitting = $state(false);
	let name = $state("");
	let domain = $state("");
	let checked = $state("");
	let debounce: ReturnType<typeof setTimeout> | undefined;

	const hostname = $derived(
		domain.trim().toLowerCase() ||
			defaultWorkstationDomain(slugify(name) || "workstation", data.baseDomain),
	);

	$effect(() => {
		const next = hostname;
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			checked = next;
		}, 400);
		return () => clearTimeout(debounce);
	});

	const owner = $derived(checked ? workstationDomainOwner(checked) : null);

	const presetId = $derived(data.preset?.id ?? "");
	const picked = $derived(data.presets.find((p) => p.id === presetId));

	function pickPreset(id: string) {
		const base = resolve("workstations/new");
		void goto(id ? `${base}?preset=${encodeURIComponent(id)}` : base, {
			replace: true,
			reset: false,
		});
	}
</script>

<div class="space-y-6 p-6 md:p-8">
  <div class="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">New Workstation</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        A browser IDE in a container, with a home directory that survives
        restarts. It starts as soon as it's created.
      </p>
    </div>
    <Button href={resolve("workstations/presets")} variant="outline">
      <Layers class="size-4" />Presets
    </Button>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  {#if data.presets.length > 0}
    <section class="panel rounded-md p-5">
      <label class={labelClass} for="preset">Start from a preset</label>
      <Select.Root onValueChange={pickPreset} type="single" value={presetId}>
        <Select.Trigger class="w-full sm:w-96" id="preset">
          {picked?.name ?? "No preset"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item label="No preset" value="" />
          {#each data.presets as preset (preset.id)}
            <Select.Item label={preset.name} value={preset.id} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-text-subtle mt-1.5 text-xs">
        {picked?.description ??
          "Fills in the form below. Change anything before creating."}
      </p>
    </section>
  {/if}

  <form
    action="?/create"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't create that workstation.",
      loading: "Creating the workstation",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Workstation created.",
    })}
  >
    {#key presetId}
      <WorkstationFields
        agentHosts={data.agentHosts}
        providers={data.gitProviders}
        values={data.preset ?? DEFAULT_WORKSTATION_FIELDS}
      >
        <div class="space-y-3">
          <div>
            <label class={labelClass} for="name">Name</label>
            <Input
              id="name"
              name="name"
              placeholder="my-app dev"
              required
              type="text"
              bind:value={name}
            />
          </div>
          <div>
            <label class={labelClass} for="domain">Domain</label>
            <Input
              id="domain"
              name="domain"
              placeholder={defaultWorkstationDomain(
                slugify(name) || "workstation",
                data.baseDomain,
              )}
              type="text"
              bind:value={domain}
            />
            {#if owner?.current}
              <p class="mt-1.5 text-xs text-amber-600">
                <code>{checked}</code> is already routed to {owner.current}.
                Pick another domain: a workstation never takes one over.
              </p>
            {:else}
              <p class="text-text-subtle mt-1.5 text-xs">
                Opens at <code>{hostname}</code>. Under its own
                <code>dev.</code> subdomain by default, so it never clashes with
                a service of the same name.
              </p>
            {/if}
          </div>
        </div>
      </WorkstationFields>
    {/key}

    <Button disabled={submitting || !!owner?.current} type="submit">
      {#if submitting}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Create workstation
    </Button>
  </form>
</div>
