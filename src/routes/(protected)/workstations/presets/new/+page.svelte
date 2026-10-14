<script lang="ts">
	import { Check } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationFields from "#lib/components/workstation-fields.svelte";
	import WorkstationPresetHead from "#lib/components/workstation-preset-head.svelte";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { DEFAULT_WORKSTATION_FIELDS } from "#lib/workstations.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();

	onMount(() => title.set("New Workstation Preset"));

	let submitting = $state(false);
</script>

<div class="space-y-6 p-6 md:p-8">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">New Workstation Preset</h1>
    <p class="text-text-muted mt-0.5 text-sm">
      Settings a new workstation can start from. Nothing runs until you create a
      workstation with it.
    </p>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    action="?/create"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't create that preset.",
      loading: "Creating the preset",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Preset created.",
    })}
  >
    <WorkstationFields
      hosts={data.hosts}
      providers={data.gitProviders}
      values={DEFAULT_WORKSTATION_FIELDS}
      wall={data.wall}
    >
      <WorkstationPresetHead description={null} name="" />
    </WorkstationFields>

    <Button disabled={submitting} type="submit">
      {#if submitting}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Create preset
    </Button>
  </form>
</div>
