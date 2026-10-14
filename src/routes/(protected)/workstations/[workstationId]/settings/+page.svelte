<script lang="ts">
	import { AlertTriangle, Layers, Stethoscope, Trash2 } from "@lucide/svelte";
	import { onMount, untrack } from "svelte";
	import { toast } from "svelte-sonner";
	import Alert from "#lib/components/alert.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import DevcontainerDetection from "#lib/components/devcontainer-detection.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import LoginWallSection from "#lib/components/login-wall-section.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import SelfTestChecks from "#lib/components/self-test-checks.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import WorkstationContainerFields from "#lib/components/workstation-container-fields.svelte";
	import WorkstationEditorFields from "#lib/components/workstation-editor-fields.svelte";
	import WorkstationGitFields from "#lib/components/workstation-git-fields.svelte";
	import WorkstationRepoFields from "#lib/components/workstation-repo-fields.svelte";
	import {
		appendDevcontainerForm,
		type DevcontainerConfig,
		mergeDevcontainerForm,
	} from "#lib/devcontainer.js";
	import { testWorkstation } from "#lib/remote/workstations.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast, toastError } from "#lib/toast.js";
	import type { WorkstationCheck } from "#lib/workstation-self-test.js";
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";

	const { data, form } = $props();
	const ws = $derived(data.workstation);

	onMount(() => title.set(`${ws.name} · Settings`));

	type Section =
		| "container"
		| "editor"
		| "general"
		| "git"
		| "preset"
		| "repository";

	let saving = $state<Section | null>(null);
	let savedPresetId = $state<string | null>(null);

	function sectionToast(section: Section, label: string) {
		return enhanceToast({
			error: "Check the form for errors.",
			loading: `Saving ${label}`,
			onSettled: () => {
				saving = null;
			},
			onStart: () => {
				saving = section;
			},
			success:
				section === "general"
					? "Saved."
					: "Saved. Start the workstation again to apply it.",
		});
	}

	let current = $state(untrack(() => ({ ...data.workstation })));
	let applied = $state(0);
	let repo = $state({ branch: "", gitUrl: "" });
	let editorForm = $state<HTMLFormElement | null>(null);
	let containerForm = $state<HTMLFormElement | null>(null);
	let devcontainerForm = $state<HTMLFormElement | null>(null);

	function applyDevcontainerConfig(config: DevcontainerConfig) {
		const formData = new FormData(editorForm ?? undefined);
		for (const [key, value] of new FormData(containerForm ?? undefined)) {
			formData.append(key, value);
		}
		current = mergeDevcontainerForm(formData, current, config);
		applied += 1;
		devcontainerForm?.requestSubmit();
	}

	let deleting = $state(false);
	let deleteVolume = $state(false);
	let deleteDialogOpen = $state(false);
	let deleteForm = $state<HTMLFormElement | null>(null);

	let checks = $state<WorkstationCheck[] | null>(null);
	let testing = $state(false);

	async function selfTestCallback() {
		testing = true;
		try {
			checks = await testWorkstation(ws.id);
		} finally {
			testing = false;
		}
		const failed = checks.filter((check) => !check.ok).length;
		if (failed > 0) {
			throw new Error(
				failed === 1 ? "1 check failed." : `${failed} checks failed.`,
			);
		}
	}

	function handleSelfTest() {
		return toast.promise(selfTestCallback(), {
			error: (error) => toastError(error, "Couldn't run the self-test."),
			loading: "Testing the workstation",
			success: "Every check passed.",
		});
	}
</script>

<div class="space-y-4">
  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    id="ws-general"
    action="?/general"
    method="POST"
    use:enhance={sectionToast("general", "the name")}
  >
    <section class="panel rounded-xl">
      <PanelHeader title="Workstation">
        {#snippet trailing()}
          <SaveButton form="ws-general" pending={saving === "general"} />
        {/snippet}
      </PanelHeader>
      <div class="p-5">
        <label class={labelClass} for="name">Name</label>
        <Input id="name" name="name" required type="text" value={ws.name} />
        <p class="text-text-subtle mt-1.5 text-xs">
          The hostname ({data.hostname}) and where it runs are fixed at
          creation.
        </p>
      </div>
    </section>
  </form>

  <form
    id="ws-repository"
    action="?/repository"
    method="POST"
    use:enhance={sectionToast("repository", "the repository")}
  >
    <WorkstationRepoFields
      onrepochange={(gitUrl, branch) => {
        repo = { branch, gitUrl };
      }}
      providers={data.gitProviders}
      values={ws}
    >
      {#snippet trailing()}
        <SaveButton form="ws-repository" pending={saving === "repository"} />
      {/snippet}
    </WorkstationRepoFields>
  </form>

  <DevcontainerDetection
    branch={repo.branch}
    gitUrl={repo.gitUrl}
    onapply={applyDevcontainerConfig}
    target="the Editor and Container sections, saved right away"
  />

  <form
    bind:this={devcontainerForm}
    class="hidden"
    action="?/devcontainer"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't save the dev container config.",
      loading: "Saving the dev container config",
      onSubmit: ({ formData }) => appendDevcontainerForm(formData, current),
      success: "Saved. Start the workstation again to apply it.",
    })}
  ></form>

  <form
    id="ws-editor"
    bind:this={editorForm}
    action="?/editor"
    method="POST"
    use:enhance={sectionToast("editor", "the editor")}
  >
    {#key applied}
      <WorkstationEditorFields values={current}>
        {#snippet trailing()}
          <SaveButton form="ws-editor" pending={saving === "editor"} />
        {/snippet}
      </WorkstationEditorFields>
    {/key}
  </form>

  <form
    id="ws-git"
    action="?/git"
    method="POST"
    use:enhance={sectionToast("git", "the git setup")}
  >
    <WorkstationGitFields providers={data.gitProviders} values={ws}>
      {#snippet trailing()}
        <SaveButton form="ws-git" pending={saving === "git"} />
      {/snippet}
    </WorkstationGitFields>
  </form>

  <LoginWallSection
    action="?/loginWall"
    authError={form?.authError}
    dashboardOrigin={data.wall.dashboardOrigin}
    emailSignIn={data.wall.emailSignIn}
    oauthProviders={data.wall.oauthProviders}
    subject="workstation"
    svc={{ ...ws, dnsResolvable: true }}
    title="Login wall"
    users={data.wall.users}
  />

  <form
    id="ws-container"
    bind:this={containerForm}
    action="?/container"
    method="POST"
    use:enhance={sectionToast("container", "the container")}
  >
    {#key applied}
      <WorkstationContainerFields values={current}>
        {#snippet trailing()}
          <SaveButton form="ws-container" pending={saving === "container"} />
        {/snippet}
      </WorkstationContainerFields>
    {/key}
  </form>

  <form
    id="ws-preset"
    action="?/savePreset"
    method="POST"
    use:enhance={enhanceToast({
      action: {
        label: "Open",
        onClick: () => {
          if (savedPresetId) {
            void goto(
              resolve("/(protected)/workstations/presets/[presetId]", {
                presetId: savedPresetId,
              }),
            );
          }
        },
      },
      error: "Couldn't save the preset.",
      loading: "Saving as a preset",
      onSettled: () => {
        saving = null;
      },
      onStart: () => {
        saving = "preset";
      },
      onSuccess: (result) => {
        savedPresetId =
          typeof result?.presetId === "string" ? result.presetId : null;
      },
      success: "Saved as a preset.",
    })}
  >
    <section class="panel rounded-xl">
      <PanelHeader
        description="Keeps this workstation's saved settings to start new ones from."
        title="Save as preset"
      >
        {#snippet trailing()}
          <Button disabled={saving === "preset"} form="ws-preset" size="sm" type="submit" variant="outline">
            {#if saving === "preset"}
              <Spinner />
            {:else}
              <Layers class="size-4" />
            {/if}
            Save as preset
          </Button>
        {/snippet}
      </PanelHeader>
      <div class="grid gap-3 p-5 sm:grid-cols-2">
        <div>
          <label class={labelClass} for="presetName">Preset name</label>
          <Input id="presetName" name="presetName" required type="text" value={ws.name} />
        </div>
        <div>
          <label class={labelClass} for="presetDescription">Description (optional)</label>
          <Input id="presetDescription" name="presetDescription" type="text" />
        </div>
      </div>
    </section>
  </form>

  <section class="panel rounded-xl">
    <div class="panel-head">
      <h2 class="eyebrow">Self-test</h2>
      <Button disabled={testing} onclick={handleSelfTest} size="sm" variant="outline">
        {#if testing}
          <Spinner />
        {:else}
          <Stethoscope class="size-4" />
        {/if}
        Run self-test
      </Button>
    </div>
    <div class="p-4">
      {#if checks}
        <SelfTestChecks {checks} />
      {:else}
        <p class="text-text-subtle text-xs">
          Checks the container runs, an agent host's published port answers,
          {data.hostname} resolves, and Traefik routes it to the IDE with a
          valid certificate.
        </p>
      {/if}
    </div>
  </section>

  <section class="rounded-xl border border-red-300/60 dark:border-red-900/50">
    <div class="flex items-center gap-3 border-b border-red-300/40 px-4 py-3 dark:border-red-900/40">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
        <AlertTriangle class="size-4" />
      </span>
      <div>
        <h2 class="text-sm font-semibold text-red-600 dark:text-red-400">
          Danger zone
        </h2>
        <p class="text-text-muted text-xs">
          Removes the container. The home volume goes too only when you ask.
        </p>
      </div>
    </div>
    <div class="space-y-4 p-4">
      <label class="flex items-start gap-3">
        <Checkbox bind:checked={deleteVolume} class="mt-0.5" />
        <span>
          <span class="text-text text-sm font-medium">Also delete the home volume</span>
          <span class="text-text-subtle block text-xs">
            Everything under {ws.homePath}, the cloned repository and any
            uncommitted work included.
          </span>
        </span>
      </label>
      <form
        action="?/delete"
        method="POST"
        bind:this={deleteForm}
        use:enhance={enhanceToast({
          error: "Couldn't delete the workstation.",
          loading: "Deleting the workstation",
          onSettled: () => {
            deleting = false;
          },
          onStart: () => {
            deleting = true;
          },
          success: "Workstation deleted.",
        })}
      >
        <input name="volume" type="hidden" value={deleteVolume ? "true" : "false"} />
        <Button
          class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
          disabled={deleting}
          onclick={() => {
            deleteDialogOpen = true;
          }}
          type="button"
          variant="outline"
        >
          {#if deleting}
            <Spinner />
          {:else}
            <Trash2 class="size-4" />
          {/if}
          Delete this workstation
        </Button>
      </form>
    </div>
  </section>
</div>

<ConfirmDialog
  confirmLabel="Delete workstation"
  description={deleteVolume
    ? "The container and its home volume are removed. Uncommitted work is lost. This can't be undone."
    : "The container is removed. Its home volume stays on the host."}
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete {ws.name}?"
  bind:open={deleteDialogOpen}
/>
