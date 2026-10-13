<script lang="ts">
	import { labelClass } from "#lib/components/form-styles.js";
	import { Input } from "#lib/components/ui/input/index.js";

	interface Props {
		description: string | null;
		name: string;
	}

	const { description, name }: Props = $props();
</script>

<div class="space-y-3">
  <div>
    <label class={labelClass} for="name">Name</label>
    <Input
      id="name"
      name="name"
      placeholder="Node 22 + my-app"
      required
      type="text"
      value={name}
    />
  </div>
  <div>
    <label class={labelClass} for="description">Description (optional)</label>
    <Input
      id="description"
      name="description"
      placeholder="What a workstation from this preset is for"
      type="text"
      value={description ?? ""}
    />
  </div>
</div>
