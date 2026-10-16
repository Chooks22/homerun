<script lang="ts">
	import { Check, GitBranch } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import GitRepoPicker from "#lib/components/git-repo-picker.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set("Watch a repository"));

	let providerId = $state("");
	let fullName = $state("");
	let defaultBranch = $state("");
	let submitting = $state(false);
</script>

<div class="space-y-6 p-5 md:p-6">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">Watch a repository</h1>
    <p class="text-text-muted mt-1 text-sm">
      Homerun reads its CI runs with your connection to the provider, every five minutes. Services
      already building from it get linked; link others from the repository's settings.
    </p>
  </div>

  {#if data.providers.length === 0}
    <EmptyState
      icon={GitBranch}
      subtitle="Connect a GitHub, GitLab or Gitea provider first, then come back to pick a repository."
      title="No git provider connected"
    >
      <Button href={resolve("git-providers")} size="sm" variant="outline">Git Providers</Button>
    </EmptyState>
  {:else}
    {#if form?.error}
      <Alert>{form.error}</Alert>
    {/if}
    <form
      action="?/watch"
      class="panel space-y-4 rounded-md p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't watch that repository.",
        loading: "Watching the repository",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Watching it. The first sync is queued.",
      })}
    >
      <input name="providerId" type="hidden" value={providerId}>
      <input name="fullName" type="hidden" value={fullName}>
      <input name="defaultBranch" type="hidden" value={defaultBranch}>
      <GitRepoPicker
        checkDockerfile={false}
        {labelClass}
        onpick={(repo, pickedProviderId) => {
          providerId = pickedProviderId;
          fullName = repo.fullName;
          defaultBranch = repo.defaultBranch;
        }}
        providers={data.providers}
      />
      <Button disabled={submitting || !fullName} type="submit">
        {#if submitting}
          <Spinner />
        {:else}
          <Check class="size-4" />
        {/if}
        Watch
      </Button>
    </form>
  {/if}
</div>
