<script lang="ts">
	import { Eye, EyeOff } from "@lucide/svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { SECRET_MASK } from "#lib/formatting.js";

	interface Props {
		autocomplete?: "current-password" | "new-password";
		class?: string;
		disabled?: boolean;
		id: string;
		label: string;
		name?: string;
		placeholder?: string;
		required?: boolean;
		value: string;
	}

	let {
		id,
		name,
		label,
		value = $bindable(""),
		autocomplete = "current-password",
		placeholder = SECRET_MASK,
		disabled = false,
		required = false,
		class: className = "",
	}: Props = $props();

	let visible = $state(false);
</script>

<div>
  <label class="text-text mb-1.5 block text-sm font-medium" for={id}>
    {label}
  </label>
  <div class="relative">
    <Input
      {autocomplete}
      class="h-10 pr-11 {className}"
      {disabled}
      {id}
      {name}
      {placeholder}
      {required}
      type={visible ? "text" : "password"}
      bind:value
    />
    <Button
      aria-label={visible ? "Hide password" : "Show password"}
      class="text-text-subtle hover:text-text absolute top-1/2 right-1.5 -translate-y-1/2"
      onclick={() => {
        visible = !visible;
      }}
      size="icon-sm"
      variant="ghost"
    >
      {#if visible}
        <EyeOff class="size-4" />
      {:else}
        <Eye class="size-4" />
      {/if}
    </Button>
  </div>
</div>
