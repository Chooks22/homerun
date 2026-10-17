<script lang="ts">
	import { GitBranch } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import RepositoryChecklist from "#lib/components/pipelines/repository-checklist.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set("Watch repositories"));

	let submitting = $state(false);
</script>

<div class="space-y-6 p-5 md:p-6">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">Watch repositories</h1>
    <p class="text-text-muted mt-1 text-sm">
      Tick as many as you like. Homerun reads their CI runs with your connection to the provider,
      every five minutes. Services already building from one get linked to it; link others from the
      repository's settings.
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
      class="panel rounded-md p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't watch those repositories.",
        loading: "Watching the repositories",
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        success: "Watching them. Their first syncs are queued.",
      })}
    >
      <RepositoryChecklist
        {labelClass}
        pending={submitting}
        providers={data.providers}
        watched={data.watched}
      />
    </form>
  {/if}
</div>
