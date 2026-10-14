<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import DevcontainerDetection from "#lib/components/devcontainer-detection.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import LoginWallSection from "#lib/components/login-wall-section.svelte";
	import * as Select from "#lib/components/ui/select/index.js";
	import WorkstationContainerFields from "#lib/components/workstation-container-fields.svelte";
	import WorkstationEditorFields from "#lib/components/workstation-editor-fields.svelte";
	import WorkstationGitFields from "#lib/components/workstation-git-fields.svelte";
	import WorkstationRepoFields from "#lib/components/workstation-repo-fields.svelte";
	import {
		type DevcontainerConfig,
		mergeDevcontainerForm,
	} from "#lib/devcontainer.js";
	import type { ConnectedGitProvider } from "#lib/server/git-connections.js";
	import type { loginWallOptions } from "#lib/server/login-wall-options.js";
	import type { WorkstationFieldValues } from "#lib/workstations.js";

	interface Props {
		children: Snippet;
		hosts: { id: string; name: string }[];
		providers: ConnectedGitProvider[];
		values: WorkstationFieldValues;
		wall: Awaited<ReturnType<typeof loginWallOptions>>;
	}

	const { children, hosts, providers, values, wall }: Props = $props();

	let remoteHostId = $state(untrack(() => values.remoteHostId ?? ""));
	let current = $state(untrack(() => ({ ...values })));
	let applied = $state(0);
	let repo = $state({ branch: "", gitUrl: "" });
	let anchor = $state<HTMLElement | null>(null);

	function apply(config: DevcontainerConfig) {
		const form = anchor?.closest("form");
		current = mergeDevcontainerForm(
			form ? new FormData(form) : new FormData(),
			current,
			config,
		);
		applied += 1;
	}
</script>

<section bind:this={anchor} class="panel space-y-4 rounded-md p-5">
  <div class="grid gap-3 sm:grid-cols-2">
    {@render children()}
    <div>
      <label class={labelClass} for="remoteHostId">Runs on</label>
      <Select.Root name="remoteHostId" type="single" bind:value={remoteHostId}>
        <Select.Trigger class="w-full" id="remoteHostId">
          {hosts.find((host) => host.id === remoteHostId)?.name ??
            "This server"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item label="This server" value="" />
          {#each hosts as host (host.id)}
            <Select.Item label={host.name} value={host.id} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-text-subtle mt-1.5 text-xs">
        Any registered agent or Docker host (tcp:// or ssh://) works too. Its
        IDE port is published on that host and routed through this server's
        Traefik.
      </p>
    </div>
  </div>
</section>

<WorkstationRepoFields
  onrepochange={(gitUrl, branch) => {
    repo = { branch, gitUrl };
  }}
  {providers}
  {values}
/>

<DevcontainerDetection
  branch={repo.branch}
  gitUrl={repo.gitUrl}
  onapply={apply}
  target="the Editor and Container sections below"
/>

{#key applied}
  <WorkstationEditorFields values={current} />
{/key}

<WorkstationGitFields {providers} {values} />

{#key applied}
  <WorkstationContainerFields values={current} />
{/key}

<LoginWallSection
  dashboardOrigin={wall.dashboardOrigin}
  emailSignIn={wall.emailSignIn}
  embedded
  oauthProviders={wall.oauthProviders}
  subject="workstation"
  svc={{ ...values, dnsResolvable: true, id: "" }}
  users={wall.users}
/>
