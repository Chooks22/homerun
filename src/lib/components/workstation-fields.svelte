<script lang="ts">
	import { Box } from "@lucide/svelte";
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import WorkstationContainerFields from "#lib/components/workstation-container-fields.svelte";
	import WorkstationEditorFields from "#lib/components/workstation-editor-fields.svelte";
	import WorkstationGitFields from "#lib/components/workstation-git-fields.svelte";
	import WorkstationRepoFields from "#lib/components/workstation-repo-fields.svelte";
	import {
		applyDevcontainer,
		type DevcontainerConfig,
		hasApplicable,
	} from "#lib/devcontainer.js";
	import { parseDotEnv } from "#lib/env-parse.js";
	import { detectDevcontainer } from "#lib/remote/workstations.remote.js";
	import type { ConnectedGitProvider } from "#lib/server/git-connections.js";
	import type { WorkstationFieldValues } from "#lib/workstations.js";

	interface Props {
		agentHosts: { id: string; name: string }[];
		children: Snippet;
		providers: ConnectedGitProvider[];
		values: WorkstationFieldValues;
	}

	const { agentHosts, children, providers, values }: Props = $props();

	let remoteHostId = $state(untrack(() => values.remoteHostId ?? ""));
	let current = $state(untrack(() => ({ ...values })));
	let applied = $state(0);
	let appliedFrom = $state("");
	let repo = $state({ branch: "", gitUrl: "" });
	let anchor = $state<HTMLElement | null>(null);
	let debounce: ReturnType<typeof setTimeout> | undefined;

	const detection = $derived(
		/^https?:\/\/\S+\/\S+/.test(repo.gitUrl) ? detectDevcontainer(repo) : null,
	);

	function repoChanged(gitUrl: string, branch: string) {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			repo = { branch, gitUrl };
		}, 500);
	}

	function jsonObject(text: string): Record<string, unknown> {
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	function apply(config: DevcontainerConfig) {
		const form = anchor?.closest("form");
		const data = form ? new FormData(form) : null;
		const env: Record<string, string> = {};
		for (const row of parseDotEnv(String(data?.get("env") ?? ""))) {
			if (row.key) {
				env[row.key] = row.value;
			}
		}
		const merged = applyDevcontainer(
			{
				editorSettings: jsonObject(String(data?.get("editorSettings") ?? "")),
				env,
				extensions: (data?.getAll("extensions") ?? []).map(String),
			},
			config,
		);
		const text = (key: string) => String(data?.get(key) ?? "").trim();
		const number = (key: string) => (text(key) ? Number(text(key)) : null);
		current = {
			...current,
			...merged,
			cpuLimit: number("cpuLimit"),
			homePath: text("homePath") || current.homePath,
			image: text("image") || current.image,
			memoryLimitMb: number("memoryLimitMb"),
			port: number("port") ?? current.port,
		};
		appliedFrom = `${repo.gitUrl}#${repo.branch}`;
		applied += 1;
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

<section bind:this={anchor} class="panel space-y-4 rounded-md p-5">
  <div class="grid gap-3 sm:grid-cols-2">
    {@render children()}
    <div>
      <label class={labelClass} for="remoteHostId">Runs on</label>
      <Select.Root name="remoteHostId" type="single" bind:value={remoteHostId}>
        <Select.Trigger class="w-full" id="remoteHostId">
          {agentHosts.find((host) => host.id === remoteHostId)?.name ??
            "This server"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item label="This server" value="" />
          {#each agentHosts as host (host.id)}
            <Select.Item label={host.name} value={host.id} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-text-subtle mt-1.5 text-xs">
        Any registered agent host works too. Its IDE port is published on that
        host and routed through this server's Traefik.
      </p>
    </div>
  </div>
</section>

<WorkstationRepoFields onrepochange={repoChanged} {providers} {values} />

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
              {summary(config)} can go into the Editor and Container sections
              below.
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
          {#if appliedFrom === `${repo.gitUrl}#${repo.branch}`}
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

{#key applied}
  <WorkstationEditorFields values={current} />
{/key}

<WorkstationGitFields {providers} {values} />

{#key applied}
  <WorkstationContainerFields values={current} />
{/key}
