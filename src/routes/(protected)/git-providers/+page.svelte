<script lang="ts">
	import { GitBranch, Link2, Plus, RefreshCw, Unlink } from "@lucide/svelte";
	import { onMount, tick } from "svelte";
	import { toast } from "svelte-sonner";
	import CopyBox from "#lib/components/copy-box.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import EntityList from "#lib/components/entity-list.svelte";
	import {
		inputClass as input,
		labelClass as label,
	} from "#lib/components/form-styles.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import { disconnectGitProvider } from "#lib/remote/git-repos.remote.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast, toastError } from "#lib/toast.js";
	import { ViewMode } from "#lib/view-mode.svelte.js";
	import { enhance } from "$app/forms";
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set("Git Providers"));

	const view = new ViewMode("git-providers");

	async function disconnectCallback(providerId: string) {
		await disconnectGitProvider(providerId);
		await refreshAll();
	}

	function handleDisconnect(providerId: string) {
		return toast.promise(disconnectCallback(providerId), {
			error: (error) => toastError(error, "Couldn't disconnect."),
			loading: "Disconnecting",
			success: "Disconnected.",
		});
	}

	const rows = $derived(
		data.providers.map((provider) => ({
			connected: data.connectedProviderIds.includes(provider.id),
			callbackUrl:
				data.canWrite &&
				provider.kind !== "github" &&
				!data.connectedProviderIds.includes(provider.id)
					? callbackUrlFor(provider.id)
					: null,
			enabled: provider.enabled,
			href: resolve("/(protected)/git-providers/[providerId]", {
				providerId: provider.id,
			}),
			id: provider.id,
			name: provider.name,
			subtitle: `${provider.kind}${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`,
			title: provider.name,
		})),
	);
	type ProviderRow = (typeof rows)[number];

	const kindOptions: [string, string][] = [
		["github", "GitHub"],
		["gitlab", "GitLab"],
		["gitea", "Gitea (self-hosted)"],
		["bitbucket", "Bitbucket"],
	];

	let showAddForm = $state(false);
	let kind = $state("github");
	const kindLabel = $derived(
		kindOptions.find(([val]) => val === kind)?.[1] ?? "GitHub",
	);
	const requiresBaseUrl = $derived(kind === "gitea");
	const isGithub = $derived(kind === "github");
	let submitting = $state(false);

	let githubApp = $state<{ action: string; manifest: string } | null>(null);
	let githubAppForm: HTMLFormElement | null = $state(null);

	async function openGithub(registration: unknown) {
		githubApp = registration as { action: string; manifest: string };
		await tick();
		githubAppForm?.submit();
	}

	function callbackUrlFor(providerId: string): string {
		if (typeof window === "undefined") {
			return "";
		}
		return `${window.location.origin}/api/v1/git-providers/${providerId}/callback`;
	}
</script>

{#snippet media(_provider: ProviderRow)}
  <div class="bg-accent/10 text-accent flex size-10 shrink-0 items-center justify-center rounded-md">
    <GitBranch class="size-5" />
  </div>
{/snippet}

{#snippet details(provider: ProviderRow)}
  {#if provider.callbackUrl}
    <div class="flex flex-col gap-1">
      <p class="text-text-muted text-xs">Callback URL for this provider's OAuth App</p>
      <CopyBox class="bg-surface-3" label="the callback URL" value={provider.callbackUrl} />
    </div>
  {/if}
{/snippet}

{#snippet badge(provider: ProviderRow)}
  {#if !provider.enabled}
    <span class="bg-surface-2 text-text-subtle shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold">
      Disabled
    </span>
  {:else if provider.connected}
    <span class="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-semibold text-emerald-600 dark:text-emerald-400">
      Connected
    </span>
  {/if}
{/snippet}

{#snippet actions(provider: ProviderRow)}
  {#if provider.connected}
    {#if provider.enabled}
      <Button href={`/api/v1/git-providers/${provider.id}/connect`} size="sm" variant="outline">
        <RefreshCw class="size-4" />
        Reconnect
      </Button>
    {/if}
    <Button
      onclick={() => handleDisconnect(provider.id)}
      size="sm"
      type="button"
      variant="outline"
    >
      <Unlink class="size-4" />
      Disconnect
    </Button>
  {:else if provider.enabled}
    <Button href={`/api/v1/git-providers/${provider.id}/connect`} size="sm">
      <Link2 class="size-4" />
      Connect
    </Button>
  {/if}
{/snippet}

<div class="p-5 md:p-6">
  <div class="mb-8 flex flex-wrap items-center justify-between gap-4">
    <div>
      <h1 class="text-text text-lg font-semibold tracking-tight">Git Providers</h1>
      <p class="text-text-muted mt-1 text-sm">
        Connect a git hosting account (GitHub, GitLab, self-hosted Gitea,
        Bitbucket) so a git-based service's Source tab can browse your repos
        instead of pasting a raw URL : no personal access token needed.
      </p>
    </div>
    {#if data.canWrite}
      <Button
        onclick={() => {
          showAddForm = !showAddForm;
        }}
      >
        <Plus class="size-4" />
        Add provider
      </Button>
    {/if}
  </div>

  {#if data.canWrite && showAddForm}
    <div class="panel mb-6 rounded-md p-5">
      <p class="text-text-subtle mb-4 text-xs">
        {#if isGithub}
          Homerun creates a GitHub App for you: GitHub asks you to confirm it,
          then to install it on the repositories Homerun should see.
        {:else}
          Register an OAuth App on the provider's own site first (its
          developer/application settings), then paste the client ID/secret
          here. The callback URL to give it is shown once you've added the
          provider below.
        {/if}
      </p>
      {#if form?.error}
        <p class="mb-4 text-sm text-red-500">{form.error}</p>
      {/if}
      <form
        action={isGithub ? "?/createGithubApp" : "?/addProvider"}
        class="space-y-4"
        method="POST"
        use:enhance={enhanceToast({
          error: "Check the form for errors.",
          loading: isGithub ? "Preparing the GitHub App" : "Adding the provider",
          onSettled: () => {
            submitting = false;
          },
          onStart: () => {
            submitting = true;
          },
          onSuccess: async (result) => {
            if (result?.githubApp) {
              await openGithub(result.githubApp);
              return;
            }
            showAddForm = false;
          },
          success: (result) => (result?.githubApp ? "Opening GitHub" : "Provider added."),
        })}
      >
        <div>
          <p class={label}>Provider</p>
          <SelectRoot name="kind" type="single" bind:value={kind}>
            <SelectTrigger class="w-full">
              {kindLabel}
            </SelectTrigger>
            <SelectContent>
              {#each kindOptions as [val, lbl] (val)}
                <SelectItem label={lbl} value={val} />
              {/each}
            </SelectContent>
          </SelectRoot>
        </div>
        <div>
          <label class={label} for="name">Name</label>
          <input
            class={input}
            id="name"
            name="name"
            placeholder={isGithub ? "e.g. homerun-acme" : "e.g. Company GitLab"}
            required
            type="text"
          />
        </div>
        {#if requiresBaseUrl}
          <div>
            <label class={label} for="baseUrl">
              Base URL <span class="text-red-500">*</span>
            </label>
            <input
              class={input}
              id="baseUrl"
              name="baseUrl"
              placeholder="https://gitea.example.com"
              required
              type="text"
            />
          </div>
        {/if}
        {#if isGithub}
          <div>
            <label class={label} for="org">Organization</label>
            <input
              class={input}
              id="org"
              name="org"
              placeholder="Leave empty to create it on your personal account"
              type="text"
            >
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class={label} for="clientId">Client ID</label>
              <input
                class={input}
                id="clientId"
                name="clientId"
                required
                type="text"
              >
            </div>
            <div>
              <label class={label} for="clientSecret">Client secret</label>
              <input
                class={input}
                id="clientSecret"
                name="clientSecret"
                required
                type="password"
              >
            </div>
          </div>
        {/if}
        <div class="flex justify-end">
          <Button disabled={submitting} type="submit">
            {isGithub ? "Create GitHub App" : "Add provider"}
          </Button>
        </div>
      </form>
      {#if githubApp}
        <form bind:this={githubAppForm} action={githubApp.action} class="hidden" method="POST">
          <input name="manifest" type="hidden" value={githubApp.manifest}>
        </form>
      {/if}
    </div>
  {/if}

  {#if data.providers.length === 0}
    <EmptyState
      icon={GitBranch}
      subtitle="Add one above to browse repos when creating a git-based service."
      title="No git providers configured"
    />
  {:else}
    <EntityList {actions} {badge} {details} items={rows} {media} {view} />
  {/if}
</div>
