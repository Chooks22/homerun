<script lang="ts">
	import { untrack } from "svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import CodeEditor from "#lib/components/code-editor.svelte";
	import CronJobFiles from "#lib/components/cron-job-files.svelte";
	import CronJobMounts from "#lib/components/cron-job-mounts.svelte";
	import EnvVarsEditor from "#lib/components/env-vars-editor.svelte";
	import { inputClass, labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import {
		type CronJobFile,
		type CronJobKind,
		type CronJobMount,
		SCRIPT_RUNTIME_SPECS,
		SCRIPT_RUNTIMES,
		type ScriptRuntime,
		scriptPath,
	} from "#lib/cron-job-script.js";
	import { languageFor } from "#lib/highlight.js";

	interface Option {
		id: string;
		name: string;
	}

	interface CronJobValues {
		command: string | null;
		dockerSocket: boolean;
		envVars: Record<string, string>;
		files: CronJobFile[];
		image: string | null;
		kind: CronJobKind;
		mounts: CronJobMount[];
		registryUrl: string | null;
		registryUsername: string | null;
		remoteHostId: string | null;
		runAsUser: string | null;
		runtime: ScriptRuntime | null;
		secretEnvKeys: string[];
		source: string | null;
		tag: string | null;
	}

	const {
		hostAccess,
		remoteHosts = [],
		values,
		volumes = [],
	}: {
		hostAccess: boolean;
		remoteHosts?: Option[];
		values: CronJobValues;
		volumes?: Option[];
	} = $props();

	const KINDS: { hint: string; label: string; value: CronJobKind }[] = [
		{
			hint: "A throwaway container from an image",
			label: "Container",
			value: "image",
		},
		{
			hint: "Your code, run on a runtime image",
			label: "Source code",
			value: "script",
		},
		{
			hint: "A shell command on the Docker host itself",
			label: "Host command",
			value: "exec",
		},
	];

	let kind = $state<CronJobKind>(untrack(() => values.kind));
	let runtime = $state<ScriptRuntime>(untrack(() => values.runtime ?? "bun"));
	let source = $state(untrack(() => values.source ?? ""));
	let remoteHostId = $state(untrack(() => values.remoteHostId ?? ""));
	let showRegistry = $state(untrack(() => !!values.registryUsername));

	function kindClass(value: CronJobKind): string {
		return value === kind
			? "border-accent bg-accent-light text-accent"
			: "border-border text-text-muted";
	}
</script>

<input name="kind" type="hidden" value={kind}>

<section class="panel space-y-4 rounded-md p-5">
  <div>
    <p class={labelClass}>Type</p>
    <div class="flex flex-wrap gap-2">
      {#each KINDS as option (option.value)}
        {@const locked = option.value === "exec" && !hostAccess}
        <button
          class="min-w-40 flex-1 rounded-md border px-3 py-2.5 text-left text-sm font-medium transition-all {kindClass(option.value)}"
          disabled={locked}
          onclick={() => {
            kind = option.value;
          }}
          type="button"
        >
          {option.label}
          <span class="text-text-subtle block text-xs font-normal">
            {locked ? "Needs write access to System" : option.hint}
          </span>
        </button>
      {/each}
    </div>
  </div>

  {#if kind === "image"}
    <div class="grid gap-3 sm:grid-cols-3">
      <div class="sm:col-span-2">
        <label class={labelClass} for="image">Image</label>
        <Input
          class=""
          id="image"
          name="image"
          placeholder="postgres"
          type="text"
          value={values.image ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="tag">Tag</label>
        <Input
          class=""
          id="tag"
          name="tag"
          placeholder="latest"
          type="text"
          value={values.tag ?? "latest"}
        />
      </div>
    </div>
  {/if}

  {#if kind === "script"}
    <div>
      <label class={labelClass} for="runtime">Runtime</label>
      <Select.Root name="runtime" type="single" bind:value={runtime}>
        <Select.Trigger class="w-full sm:w-64" id="runtime">
          {SCRIPT_RUNTIME_SPECS[runtime].label}
        </Select.Trigger>
        <Select.Content>
          {#each SCRIPT_RUNTIMES as value (value)}
            <Select.Item label={SCRIPT_RUNTIME_SPECS[value].label} {value} />
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="text-text-subtle mt-1 text-xs">
        Runs <code>{SCRIPT_RUNTIME_SPECS[runtime].run(scriptPath(runtime)).join(" ")}</code>
        on <code>{SCRIPT_RUNTIME_SPECS[runtime].image}</code>. A non-zero exit
        fails the run.
      </p>
    </div>
    <div>
      <p class={labelClass}>Source code</p>
      <CodeEditor
        aria-label="Source code"
        language={languageFor(scriptPath(runtime))}
        name="source"
        bind:value={source}
      />
    </div>
  {/if}

  {#if kind !== "exec"}
    {#if remoteHosts.length > 0}
      <div>
        <label class={labelClass} for="remoteHostId">Run on</label>
        <Select.Root name="remoteHostId" type="single" bind:value={remoteHostId}>
          <Select.Trigger class="w-full" id="remoteHostId">
            {remoteHosts.find((host) => host.id === remoteHostId)?.name ??
              "This host"}
          </Select.Trigger>
          <Select.Content>
            <Select.Item label="This host" value="" />
            {#each remoteHosts as host (host.id)}
              <Select.Item label={host.name} value={host.id} />
            {/each}
          </Select.Content>
        </Select.Root>
        <p class="text-text-subtle mt-1 text-xs">
          Which Docker daemon runs the container. A Homerun Agent host can't
          take one-off runs : pick a Docker-socket host, or this one.
        </p>
      </div>
    {/if}
  {/if}

  {#if kind !== "script"}
    <div>
      <label class={labelClass} for="command">
        {kind === "exec" ? "Command" : "Command override (optional)"}
      </label>
      <Input
        class=""
        id="command"
        name="command"
        placeholder={kind === "exec"
          ? "/usr/local/bin/backup.sh"
          : 'pg_dump -h db app'}
        type="text"
        value={values.command ?? ""}
      />
      <p class="text-text-subtle mt-1 text-xs">
        {kind === "exec"
          ? "Runs through sh -c as root on the Docker host, outside every container. Only this job's env vars are set."
          : "Blank runs the image's own entrypoint. Quotes group arguments; a JSON array is taken as-is."}
      </p>
    </div>
  {/if}

  {#if kind !== "exec"}
    <div>
      <label class={labelClass} for="runAsUser">User (optional)</label>
      <Input
        id="runAsUser"
        name="runAsUser"
        placeholder="12021"
        type="text"
        value={values.runAsUser ?? ""}
      />
      <p class="text-text-subtle mt-1 text-xs">
        uid, uid:gid, name or name:group. Blank runs as the image's own user.
      </p>
    </div>
    {#if hostAccess}
      <CheckBox
        checked={values.dockerSocket}
        helperText="Mounts this host's Docker socket at /var/run/docker.sock, with its group added so a non-root user can use it. That's root on the host: only users with write access to System can set or manage it."
        id="dockerSocket"
        label="Docker socket"
        name="dockerSocket"
      />
    {/if}
  {/if}
</section>

<section class="panel rounded-md">
  <PanelHeader
    description="The lock marks a value secret: it's hidden here and always redacted for AI agents, whatever its name."
    title="Environment variables"
  />
  <div class="space-y-2.5 p-5">
    <EnvVarsEditor envVars={values.envVars} secretEnvKeys={values.secretEnvKeys} />
  </div>
</section>

{#if kind !== "exec"}
  <CronJobFiles files={values.files} />
  <CronJobMounts mounts={values.mounts} {volumes} />
{/if}

{#if kind === "image"}
  <section class="panel rounded-md p-5">
    <Button
      class="h-auto p-0"
      onclick={() => {
        showRegistry = !showRegistry;
      }}
      variant="link"
    >
      {showRegistry ? "Hide" : "Use"} a private registry
    </Button>
    <div class="grid gap-3 sm:grid-cols-3" class:hidden={!showRegistry}>
      <div>
        <label class={labelClass} for="registryUrl">Registry URL</label>
        <Input
          class=""
          id="registryUrl"
          name="registryUrl"
          placeholder="ghcr.io"
          type="text"
          value={values.registryUrl ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="registryUsername">Username</label>
        <Input
          id="registryUsername"
          name="registryUsername"
          type="text"
          value={values.registryUsername ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="registryPassword">Password</label>
        <input
          class={inputClass}
          id="registryPassword"
          name="registryPassword"
          placeholder="Leave blank to keep the stored one"
          type="password"
        >
      </div>
    </div>
  </section>
{/if}
