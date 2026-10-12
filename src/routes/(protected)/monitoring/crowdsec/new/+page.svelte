<script lang="ts">
	import { Check } from "@lucide/svelte";
	import Alert from "#lib/components/alert.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { form } = $props();

	let submitting = $state(false);
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-text text-base font-semibold tracking-tight">New decision</h2>
    <p class="text-text-muted mt-0.5 text-sm">
      Bans an address through CrowdSec, so its bouncers drop it. Homerun's own
      Traefik isn't told: this is CrowdSec's ban, not one of Homerun's IP bans.
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
      error: "Couldn't add that decision.",
      loading: "Adding the decision",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Decision added.",
    })}
  >
    <div class="grid gap-4 sm:grid-cols-3">
      <div>
        <label class={label} for="ip">IP address</label>
        <Input id="ip" name="ip" placeholder="203.0.113.9" required />
      </div>
      <div>
        <label class={label} for="durationHours">Ban for (hours)</label>
        <Input
          id="durationHours"
          max="8760"
          min="0"
          name="durationHours"
          required
          type="number"
          value="24"
        />
      </div>
      <div>
        <label class={label} for="reason">Reason</label>
        <Input id="reason" name="reason" placeholder="manual ban" />
      </div>
    </div>
    <p class="text-text-subtle text-xs">0 hours bans for ten years.</p>

    <Button disabled={submitting} type="submit">
      {#if submitting}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Add decision
    </Button>
  </form>
</div>
