<script lang="ts">
	import { labelClass as label } from "#lib/components/form-styles.js";
	import ResponsiveDialog from "#lib/components/responsive-dialog.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import type { SwarmNodeInfo } from "#lib/services/docker.service.js";
	import { formatNodeLabels } from "#lib/swarm-placement.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	let {
		node,
		open = $bindable(false),
	}: { node: SwarmNodeInfo | null; open?: boolean } = $props();

	let pending = $state(false);
</script>

<ResponsiveDialog
  description="Placement constraints and spread preferences on a service's Compute tab match these labels."
  size="md"
  title={node ? `Labels of ${node.hostname}` : "Node labels"}
  bind:open
>
  {#if node}
    <form
      action="?/setNodeLabels"
      class="space-y-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the labels.",
        loading: `Saving ${node.hostname}'s labels`,
        onSettled: () => {
          pending = false;
        },
        onStart: () => {
          pending = true;
        },
        onSuccess: () => {
          open = false;
        },
        success: "Labels saved.",
      })}
    >
      <input name="nodeId" type="hidden" value={node.id} />
      <div>
        <label class={label} for="node-labels">Labels</label>
        <Textarea
          class="font-mono"
          content={formatNodeLabels(node.labels)}
          id="node-labels"
          name="labels"
          placeholder={"env=staging\nzone=eu-west"}
          rows={5}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          One <code>key=value</code> per line. A service constrained to
          <code>env==staging</code> only runs on nodes labelled
          <code>env=staging</code>.
        </p>
      </div>
      <div class="flex justify-end">
        <Button disabled={pending} type="submit">Save labels</Button>
      </div>
    </form>
  {/if}
</ResponsiveDialog>
