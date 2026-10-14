<script lang="ts">
	import { Check } from "@lucide/svelte";
	import { onMount } from "svelte";
	import Alert from "#lib/components/alert.svelte";
	import CronJobFields from "#lib/components/cron-job-fields.svelte";
	import CronJobSettingsFields from "#lib/components/cron-job-settings-fields.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data, form } = $props();

	onMount(() => title.set("New Cron Job"));

	let submitting = $state(false);
</script>

<div class="space-y-6 p-6 md:p-8">
  <div>
    <h1 class="text-text text-lg font-semibold tracking-tight">New Cron Job</h1>
    <p class="text-text-muted mt-0.5 text-sm">
      A container, your own source code, or a host command, run on a
      schedule or on demand through the same job queue as deploys and
      backups.
    </p>
  </div>

  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <form
    action="?/create"
    class="space-y-4"
    method="POST"
    use:enhance={enhanceToast({
      error: "Couldn't create that cron job.",
      loading: "Creating the cron job",
      onSettled: () => {
        submitting = false;
      },
      onStart: () => {
        submitting = true;
      },
      success: "Cron job created.",
    })}
  >
    <CronJobSettingsFields
      values={{
        description: null,
        enabled: true,
        name: "",
        schedule: "0 3 * * *",
        timeoutSeconds: 900,
      }}
    />
    <CronJobFields
      hostAccess={data.hostAccess}
      remoteHosts={data.remoteHosts}
      values={{
        command: null,
        dockerSocket: false,
        envVars: {},
        files: [],
        image: null,
        kind: "image",
        mounts: [],
        registryUrl: null,
        registryUsername: null,
        remoteHostId: null,
        runAsUser: null,
        runtime: null,
        secretEnvKeys: [],
        source: null,
        tag: "latest",
      }}
      volumes={data.volumes}
    />

    <Button disabled={submitting} type="submit">
      {#if submitting}
        <Spinner />
      {:else}
        <Check class="size-4" />
      {/if}
      Create cron job
    </Button>
  </form>
</div>
