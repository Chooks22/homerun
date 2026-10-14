<script lang="ts">
	import CheckBox from "#lib/components/check-box.svelte";
	import { Textarea } from "#lib/components/ui/textarea/index.js";

	interface Props {
		copyVolumes: boolean;
		inheritEnv: boolean;
		/** The overrides as `KEY=value` lines. */
		overrides: string;
		uptimeEnabled: boolean;
	}

	const props: Props = $props();

	let previewInheritEnv = $derived(props.inheritEnv);
	let previewCopyVolumes = $derived(props.copyVolumes);
	let previewUptimeEnabled = $derived(props.uptimeEnabled);

	const label = "block mb-1.5 text-sm font-medium text-text";
</script>

          <CheckBox
            helperText="Each preview gets this service's environment variables, with this service's own hostnames in them pointed at the preview. Off, a preview starts with only the overrides below."
            id="previewInheritEnv"
            label="Start from this service's environment variables"
            name="previewInheritEnv"
            bind:checked={previewInheritEnv}
          />

          <div>
            <label class={label} for="previewEnvOverrides">
              Environment overrides
            </label>
            <Textarea
              class="font-mono text-xs"
              id="previewEnvOverrides"
              name="previewEnvOverrides"
              placeholder={"DATABASE_URL=postgres://app@db/app_pr_{pr}\nFEATURE_FLAGS=preview"}
              rows={4}
              value={props.overrides}
            />
            <p class="text-text-subtle mt-1.5 text-xs">
              One <code>KEY=value</code> per line, set on every preview over
              whatever it inherited. <code>{"{pr}"}</code>,
              <code>{"{branch}"}</code> and <code>{"{slug}"}</code> are filled in
              per preview. Applied when a preview is created or its pull request
              is updated.
            </p>
          </div>

          <CheckBox
            helperText="A new preview gets its own copy of every volume this service mounts, made during its first deploy, and removed with the preview. A large volume makes that first deploy slower and takes the space again."
            id="previewCopyVolumes"
            label="Copy this service's volumes into each new preview"
            name="previewCopyVolumes"
            bind:checked={previewCopyVolumes}
          />

          <CheckBox
            helperText="Each preview gets the internal and public uptime probes, and its down and recovered alerts. Applied when a preview is created or redeployed."
            id="previewUptimeEnabled"
            label="Probe each preview's uptime"
            name="previewUptimeEnabled"
            bind:checked={previewUptimeEnabled}
          />
