<script lang="ts">
	import {
		ExternalLink,
		KeyRound,
		Play,
		RotateCw,
		Square,
	} from "@lucide/svelte";
	import { onMount, untrack } from "svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import StatusBadge from "#lib/components/status-badge.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import * as Select from "#lib/components/ui/select/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { workstationStatus } from "#lib/remote/workstations.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import type { ContainerStatus } from "#lib/types.js";
	import {
		type AutoStopMode,
		autoStopLabel,
		isWorkstationBusy,
		repoDirectory,
		type WorkstationState,
		workstationStateLabel,
	} from "#lib/workstations.js";
	import { enhance } from "$app/forms";

	const { data } = $props();
	const ws = $derived(data.workstation);

	onMount(() => title.set(ws.name));

	const status = $derived(workstationStatus(ws.id));
	const phase = $derived<WorkstationState | null>(
		status.current?.status.state ?? null,
	);
	const busy = $derived(phase !== null && isWorkstationBusy(phase));
	const running = $derived(phase === "running");

	onMount(() => {
		let elapsed = 0;
		const timer = setInterval(() => {
			elapsed += 3;
			if (busy || elapsed >= 15) {
				elapsed = 0;
				void status.refresh();
			}
		}, 3000);
		return () => clearInterval(timer);
	});

	function badgeStatus(value: WorkstationState): ContainerStatus {
		if (value === "cloning" || value === "configuring") {
			return "starting";
		}
		return value;
	}

	let pending = $state<"" | "start" | "stop" | "password" | "autoStop">("");

	const AUTO_STOP_OPTIONS: { label: string; value: AutoStopMode | "off" }[] = [
		{ label: "Never", value: "off" },
		{ label: "When nobody uses it", value: "idle" },
		{ label: "After a set time", value: "timer" },
	];

	let autoStopMode = $state<string>(untrack(() => ws.autoStopMode ?? "off"));
	let autoStopMinutes = $state(untrack(() => ws.autoStopMinutes ?? 60));

	const autoStopAt = $derived(
		running ? (status.current?.autoStopAt ?? null) : null,
	);

	function lifecycle(kind: "start" | "stop") {
		return enhanceToast({
			error:
				kind === "start"
					? "Couldn't start the workstation."
					: "Couldn't stop the workstation.",
			loading:
				kind === "start"
					? "Starting the workstation"
					: "Stopping the workstation",
			onComplete: () => status.refresh(),
			onSettled: () => {
				pending = "";
			},
			onStart: () => {
				pending = kind;
			},
			success:
				kind === "start" ? "Workstation starting." : "Workstation stopped.",
		});
	}
</script>

<div class="space-y-4">
  <section class="panel rounded-xl">
    <PanelHeader title="Status" />
    <div class="space-y-4 p-5">
      <div class="flex flex-wrap items-center gap-3">
        {#if phase}
          <StatusBadge status={badgeStatus(phase)} />
          <span class="text-text text-sm">{workstationStateLabel(phase)}</span>
        {:else if status.error}
          <span class="text-sm text-red-500">
            Couldn't read the workstation's status : {status.error.message}
          </span>
        {:else}
          <Spinner />
        {/if}

        <div class="ml-auto flex flex-wrap gap-2">
          {#if status.current?.url}
            <Button href={status.current.url} rel="noopener" target="_blank">
              <ExternalLink class="size-4" />Open IDE
            </Button>
          {/if}
          <form action="?/start" method="POST" use:enhance={lifecycle("start")}>
            <Button disabled={pending !== "" || busy} type="submit" variant="outline">
              {#if pending === "start"}
                <Spinner />
              {:else if running}
                <RotateCw class="size-4" />
              {:else}
                <Play class="size-4" />
              {/if}
              {running ? "Recreate" : "Start"}
            </Button>
          </form>
          {#if running || busy}
            <form action="?/stop" method="POST" use:enhance={lifecycle("stop")}>
              <Button disabled={pending !== ""} type="submit" variant="outline">
                {#if pending === "stop"}
                  <Spinner />
                {:else}
                  <Square class="size-4" />
                {/if}
                Stop
              </Button>
            </form>
          {/if}
        </div>
      </div>

      {#if status.current?.status.error}
        <p class="rounded-md bg-red-500/10 px-3 py-2 font-mono text-xs break-words text-red-600">
          {status.current.status.error}
        </p>
      {:else if ws.lastError && !running}
        <p class="rounded-md bg-red-500/10 px-3 py-2 font-mono text-xs break-words text-red-600">
          {ws.lastError}
        </p>
      {/if}

      {#if status.current?.url}
        <CopyBox label="Copy URL" value={status.current.url} />
      {/if}

      {#if autoStopAt}
        <p class="text-text text-sm">
          Stops automatically around
          {autoStopAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{ws.autoStopMode === "idle"
            ? ", later if a browser is still connected by then"
            : ""}.
        </p>
      {/if}

      <p class="text-text-subtle text-xs">
        Start recreates the container from the current settings; the home
        directory ({ws.homePath}) is a volume and survives it.
        {#if ws.gitUrl}
          The repository lives in <code>{ws.homePath.replace(/\/+$/, "")}/{repoDirectory(ws.gitUrl)}</code>.
        {/if}
      </p>
    </div>
  </section>

  <section class="panel rounded-xl">
    <PanelHeader title="Auto-stop" />
    <form
      class="space-y-3 p-5"
      action="?/autoStop"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the auto-stop.",
        loading: "Saving the auto-stop",
        onComplete: () => status.refresh(),
        onSettled: () => {
          pending = "";
        },
        onStart: () => {
          pending = "autoStop";
        },
        success: "Auto-stop saved.",
      })}
    >
      <div class="grid gap-3 sm:grid-cols-[16rem_10rem_auto] sm:items-end">
        <div>
          <label class={labelClass} for="autoStopMode">Stop the workstation</label>
          <Select.Root name="autoStopMode" type="single" bind:value={autoStopMode}>
            <Select.Trigger class="w-full" id="autoStopMode">
              {AUTO_STOP_OPTIONS.find((option) => option.value === autoStopMode)?.label}
            </Select.Trigger>
            <Select.Content>
              {#each AUTO_STOP_OPTIONS as option (option.value)}
                <Select.Item label={option.label} value={option.value} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        {#if autoStopMode !== "off"}
          <div>
            <label class={labelClass} for="autoStopMinutes">After (minutes)</label>
            <Input
              id="autoStopMinutes"
              max={10080}
              min={5}
              name="autoStopMinutes"
              type="number"
              bind:value={autoStopMinutes}
            />
          </div>
        {/if}
        <Button class="w-fit" disabled={pending !== ""} type="submit" variant="outline">
          {#if pending === "autoStop"}
            <Spinner />
          {/if}
          Save
        </Button>
      </div>
      <p class="text-text-subtle text-xs">
        Currently: {autoStopLabel(ws.autoStopMode, ws.autoStopMinutes)}.
        "When nobody uses it" stops it once no browser has been connected to
        the IDE for that long, an open tab keeps it running. "After a set time"
        stops it that long after it starts, open tab or not. Saving restarts
        the countdown of a running workstation; the home volume survives a
        stop either way.
      </p>
    </form>
  </section>

  <section class="panel rounded-xl">
    <PanelHeader title="IDE password" />
    <div class="space-y-3 p-5">
      {#if data.password}
        <CopyBox label="Copy password" value={data.password} />
      {:else}
        <p class="text-sm text-red-500">
          The stored password can't be decrypted. Reset it.
        </p>
      {/if}
      <div class="flex flex-wrap items-center gap-3">
        <form
          action="?/resetPassword"
          method="POST"
          use:enhance={enhanceToast({
            error: "Couldn't reset the password.",
            loading: "Resetting the password",
            onSettled: () => {
              pending = "";
            },
            onStart: () => {
              pending = "password";
            },
            success: "Password reset. Recreate the workstation to apply it.",
          })}
        >
          <Button disabled={pending !== ""} size="sm" type="submit" variant="outline">
            {#if pending === "password"}
              <Spinner />
            {:else}
              <KeyRound class="size-4" />
            {/if}
            Reset password
          </Button>
        </form>
        <p class="text-text-subtle text-xs">
          Passed to the container as <code>PASSWORD</code>, which code-server
          asks for on sign-in. A new one takes effect on the next start.
        </p>
      </div>
    </div>
  </section>
</div>
