<script lang="ts">
	import { ExternalLink, Layers, Pencil, Plus, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import EnvironmentBadge from "#lib/components/environment-badge.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import ResponsiveDialog from "#lib/components/responsive-dialog.svelte";
	import StatusBadge from "#lib/components/status-badge.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { deployEnvironment } from "#lib/release-channels.js";
	import { primaryHostname } from "#lib/service-domains.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();
	const svc = $derived(data.service);
	const isGit = $derived(svc.buildSource === "git");
	const refLabel = $derived(isGit ? "Branch" : "Image tag");
	const refPlaceholder = $derived(
		isGit ? (svc.gitRef ?? "main") : (svc.tag ?? "latest"),
	);

	onMount(() => title.set(`${svc.name} · Environments`));

	const hostnameOf = (
		row: Parameters<typeof primaryHostname>[0] & {
			dnsResolvable: boolean;
		},
	) =>
		row.dnsResolvable
			? primaryHostname(row, data.stackSlug, data.serviceDomain)
			: null;

	const taken = $derived([
		deployEnvironment(svc),
		...data.environments.map((entry) => entry.environmentName ?? ""),
		...(svc.channelsEnabled ? ["canary"] : []),
	]);
	const presets = $derived(
		data.presets.filter((preset) => !taken.includes(preset)),
	);

	const rows = $derived([
		{
			editable: false,
			environment: deployEnvironment(svc),
			hostname: hostnameOf(svc),
			id: svc.id,
			name: svc.name,
			note: "This service",
			status: svc.currentStatus,
		},
		...(data.canary
			? [
					{
						editable: false,
						environment: "canary",
						hostname: data.canary.hostname,
						id: data.canary.id,
						name: data.canary.name,
						note: "Release channel canary, managed under Channels",
						status: data.canary.status,
					},
				]
			: []),
		...data.environments.map((entry) => ({
			editable: true,
			environment: entry.environmentName ?? "",
			hostname: hostnameOf(entry),
			id: entry.id,
			name: entry.name,
			note: `${refLabel} ${entry.ref}`,
			status: entry.currentStatus,
		})),
		...data.previews.map((preview) => ({
			editable: false,
			environment: "preview",
			hostname: preview.hostname,
			id: preview.id,
			name: `#${preview.prNumber} ${preview.title ?? preview.name}`,
			note: "Pull request preview, managed under Previews",
			status: preview.status,
		})),
	]);

	let createOpen = $state(false);
	let creating = $state(false);
	let createForm = $state<HTMLFormElement>();
	let editForm = $state<HTMLFormElement>();
	let newName = $state("");
	let deployNow = $state(true);

	let editOpen = $state(false);
	let saving = $state(false);
	let editing = $state<(typeof data.environments)[number] | null>(null);

	let deleteOpen = $state(false);
	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let deleteForm = $state<HTMLFormElement>();

	function openCreate() {
		newName = presets[0] ?? "";
		createOpen = true;
	}

	function openEdit(id: string) {
		editing = data.environments.find((entry) => entry.id === id) ?? null;
		editOpen = editing !== null;
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Where this service runs: the service itself, the environments created from it, its release channel canary and its pull request previews. An environment follows this service's build and runtime settings, with its own {isGit ? 'branch' : 'image tag'}, domain and environment variables."
    icon={Layers}
    title="Environments"
  >
    {#snippet trailing()}
      {#if !svc.previewParentId}
        <Button onclick={openCreate} size="sm">
          <Plus class="size-4" />
          New environment
        </Button>
      {/if}
    {/snippet}
  </PanelHeader>
  <ul class="divide-border divide-y">
    {#each rows as row (row.id)}
      <li class="flex flex-wrap items-center gap-3 px-5 py-3">
        <EnvironmentBadge environment={row.environment} />
        <div class="min-w-0 flex-1">
          <a
            class="text-text text-sm font-medium hover:underline"
            href={resolve("/(protected)/services/[serviceId]", {
              serviceId: row.id,
            })}
          >
            {row.name}
          </a>
          <p class="text-text-subtle mt-0.5 text-xs">{row.note}</p>
          {#if row.hostname}
            <a
              class="text-accent mt-0.5 flex w-fit items-center gap-1 text-xs hover:underline"
              href="{data.publicScheme}://{row.hostname}"
              rel="noopener noreferrer"
              target="_blank"
            >
              {row.hostname}
              <ExternalLink class="size-3" />
            </a>
          {/if}
        </div>
        <StatusBadge status={row.status} />
        {#if row.editable}
          <div class="flex items-center gap-1">
            <Button
              aria-label="Edit {row.environment}"
              onclick={() => openEdit(row.id)}
              size="icon-sm"
              variant="ghost"
            >
              <Pencil class="size-4" />
            </Button>
            <Button
              aria-label="Delete {row.environment}"
              class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
              onclick={() => {
                deleteTarget = { id: row.id, name: row.environment };
                deleteOpen = true;
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<ResponsiveDialog
  description="A new deployment of this service under its own name."
  loading={creating}
  loadingLabel="Creating…"
  onsubmit={() => createForm?.requestSubmit()}
  size="sm"
  submitLabel="Create"
  title="New environment"
  bind:open={createOpen}
>
  <form
    bind:this={createForm}
    action="?/createEnvironment"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't create the environment.",
      loading: "Creating the environment",
      onSettled: () => {
        creating = false;
      },
      onStart: () => {
        creating = true;
      },
      onSuccess: () => {
        createOpen = false;
      },
      success: (result) => {
        const outcome = result as
          | { created?: string; deployed?: boolean }
          | undefined;
        return `${outcome?.created ?? "Environment"} created${outcome?.deployed ? ", first deploy queued" : ""}.`;
      },
    })}
  >
    {#if presets.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each presets as preset (preset)}
          <Button
            aria-pressed={newName === preset}
            onclick={() => {
              newName = preset;
            }}
            size="xs"
            variant={newName === preset ? "default" : "outline"}
          >
            {preset}
          </Button>
        {/each}
      </div>
    {/if}
    <div>
      <label class={labelClass} for="environmentName">Name</label>
      <Input
        id="environmentName"
        name="name"
        placeholder="staging"
        required
        type="text"
        bind:value={newName}
      />
    </div>
    <div>
      <label class={labelClass} for="environmentRef">{refLabel}</label>
      <Input
        id="environmentRef"
        name="ref"
        placeholder={refPlaceholder}
        required
        type="text"
        value={refPlaceholder}
      />
    </div>
    <div>
      <label class={labelClass} for="environmentDomain">Domain (optional)</label>
      <Input
        id="environmentDomain"
        name="domain"
        placeholder="staging.example.com"
        type="text"
      />
    </div>
    <div>
      <label class={labelClass} for="environmentOverrides">
        Variable overrides (optional)
      </label>
      <Textarea
        id="environmentOverrides"
        name="envOverrides"
        placeholder="DATABASE_URL=postgres://staging-db/app"
        rows={3}
      />
      <p class="text-text-subtle mt-1.5 text-xs">
        One KEY=value per line, on top of a copy of this service's variables
        (with its hostnames pointed at the environment).
      </p>
    </div>
    <CheckBox
      helperText="Clear it to set its variables up first, then deploy it from its own page."
      id="environmentDeploy"
      label="Deploy it now"
      name="deploy"
      bind:checked={deployNow}
    />
  </form>
</ResponsiveDialog>

<ResponsiveDialog
  description="Saving doesn't redeploy it: deploy it from its own page when you're ready."
  loading={saving}
  loadingLabel="Saving…"
  onsubmit={() => editForm?.requestSubmit()}
  size="sm"
  submitLabel="Save"
  title="Edit {editing?.environmentName ?? 'environment'}"
  bind:open={editOpen}
>
  {#if editing}
    <form
      bind:this={editForm}
      action="?/updateEnvironment"
      class="space-y-4"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the environment.",
        loading: "Saving the environment",
        onSettled: () => {
          saving = false;
        },
        onStart: () => {
          saving = true;
        },
        onSuccess: () => {
          editOpen = false;
        },
        success: "Environment saved.",
      })}
    >
      <input name="environmentId" type="hidden" value={editing.id} />
      <div>
        <label class={labelClass} for="editRef">{refLabel}</label>
        <Input id="editRef" name="ref" required type="text" value={editing.ref} />
      </div>
      <div>
        <label class={labelClass} for="editDomain">Domain (optional)</label>
        <Input
          id="editDomain"
          name="domain"
          placeholder="staging.example.com"
          type="text"
          value={editing.primaryDomain ?? editing.domains[0] ?? ""}
        />
      </div>
      <div>
        <label class={labelClass} for="editOverrides">
          Variable overrides (optional)
        </label>
        <Textarea
          id="editOverrides"
          name="envOverrides"
          placeholder="DATABASE_URL=postgres://staging-db/app"
          rows={3}
        />
        <p class="text-text-subtle mt-1.5 text-xs">
          Set on top of its current variables. Its full list is under its own
          Environment Variables section.
        </p>
      </div>
    </form>
  {/if}
</ResponsiveDialog>

<form
  bind:this={deleteForm}
  action="?/deleteEnvironment"
  class="hidden"
  method="POST"
  use:enhance={enhanceToast({
    error: "Couldn't delete the environment.",
    loading: `Deleting ${deleteTarget?.name ?? "the environment"}`,
    success: "Environment deleted.",
  })}
>
  <input name="environmentId" type="hidden" value={deleteTarget?.id ?? ""} />
</form>

<ConfirmDialog
  confirmLabel="Delete"
  description="Removes its container, domains and DNS records. This service and its other environments aren't touched."
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete the {deleteTarget?.name ?? ''} environment?"
  bind:open={deleteOpen}
/>
