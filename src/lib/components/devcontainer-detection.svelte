<script lang="ts">
	import { Box } from "@lucide/svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { type DevcontainerConfig, hasApplicable } from "#lib/devcontainer.js";
	import { detectDevcontainer } from "#lib/remote/workstations.remote.js";

	interface Props {
		branch: string;
		gitUrl: string;
		onapply: (config: DevcontainerConfig) => void;
		target: string;
	}

	const { branch, gitUrl, onapply, target }: Props = $props();

	let repo = $state({ branch: "", gitUrl: "" });
	let appliedFrom = $state("");

	$effect(() => {
		const next = { branch, gitUrl };
		const timer = setTimeout(() => {
			repo = next;
		}, 500);
		return () => clearTimeout(timer);
	});

	const detection = $derived(
		/^https?:\/\/\S+\/\S+/.test(repo.gitUrl) ? detectDevcontainer(repo) : null,
	);
	const repoKey = $derived(`${repo.gitUrl}#${repo.branch}`);

	function apply(config: DevcontainerConfig) {
		appliedFrom = repoKey;
		onapply(config);
	}

	function summary(config: DevcontainerConfig): string {
		const parts = [
			[config.extensions.length, "extension"],
			[Object.keys(config.settings).length, "setting"],
			[Object.keys(config.env).length, "env var"],
		] as const;
		return parts
			.filter(([count]) => count > 0)
			.map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`)
			.join(", ");
	}
</script>

{#if detection}
  {#await detection then config}
    {#if config}
      <section class="panel flex flex-wrap items-start gap-3 rounded-md p-4">
        <span class="bg-accent/10 text-accent flex size-8 shrink-0 items-center justify-center rounded-md">
          <Box class="size-4" />
        </span>
        <div class="min-w-0 flex-1 text-sm">
          <p class="text-text font-medium">
            Dev container config found: <code>{config.path}</code>{config.name
              ? ` (${config.name})`
              : ""}
          </p>
          <p class="text-text-subtle mt-0.5 text-xs">
            {#if hasApplicable(config)}
              {summary(config)} can go into {target}.
            {:else}
              Nothing in it a workstation can apply.
            {/if}
            {#if config.unsupported.length > 0}
              Not applied: {config.unsupported.join(", ")}. A workstation runs
              a web IDE image rather than the dev container's own.
            {/if}
          </p>
        </div>
        {#if hasApplicable(config)}
          {#if appliedFrom === repoKey}
            <span class="text-text-muted text-xs font-medium">Applied</span>
          {:else}
            <Button onclick={() => apply(config)} size="sm" type="button" variant="outline">
              Apply
            </Button>
          {/if}
        {/if}
      </section>
    {/if}
  {:catch}
    {""}
  {/await}
{/if}
