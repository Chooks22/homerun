<script lang="ts">
	import type { Snippet } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import {
		DEFAULT_WORKSTATION_HOME,
		DEFAULT_WORKSTATION_IMAGE,
		DEFAULT_WORKSTATION_PORT,
	} from "#lib/workstations.js";

	interface Props {
		trailing?: Snippet;
		values: {
			cpuLimit: number | null;
			env: Record<string, string>;
			homePath: string;
			image: string;
			memoryLimitMb: number | null;
			port: number;
		};
	}

	const { trailing, values }: Props = $props();

	const envText = $derived(
		Object.entries(values.env)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
	);
</script>

<section class="panel rounded-xl">
  <PanelHeader title="Container" {trailing} />
  <div class="space-y-4 p-5">
    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label class={labelClass} for="image">Image</label>
        <Input
          id="image"
          name="image"
          placeholder={DEFAULT_WORKSTATION_IMAGE}
          type="text"
          value={values.image}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          Any image serving a web IDE over HTTP. Homerun sets <code>PASSWORD</code>,
          which code-server uses for its login.
        </p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class={labelClass} for="port">IDE port</label>
          <Input
            id="port"
            max="65535"
            min="1"
            name="port"
            placeholder={String(DEFAULT_WORKSTATION_PORT)}
            type="number"
            value={values.port}
          />
        </div>
        <div>
          <label class={labelClass} for="homePath">Home path</label>
          <Input
            id="homePath"
            name="homePath"
            placeholder={DEFAULT_WORKSTATION_HOME}
            type="text"
            value={values.homePath}
          />
        </div>
      </div>
      <div>
        <label class={labelClass} for="cpuLimit">CPU limit (cores, optional)</label>
        <Input
          id="cpuLimit"
          min="0.1"
          name="cpuLimit"
          placeholder="unlimited"
          step="0.1"
          type="number"
          value={values.cpuLimit ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="memoryLimitMb">Memory limit (MB, optional)</label>
        <Input
          id="memoryLimitMb"
          min="128"
          name="memoryLimitMb"
          placeholder="unlimited"
          step="1"
          type="number"
          value={values.memoryLimitMb ?? ""}
        />
      </div>
    </div>
    <div>
      <label class={labelClass} for="env">Environment variables (optional)</label>
      <Textarea
        class="font-mono text-xs"
        content={envText}
        id="env"
        name="env"
        placeholder={"KEY=value\nOTHER=value"}
        rows={4}
      />
    </div>
  </div>
</section>
