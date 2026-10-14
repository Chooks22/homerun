<script lang="ts">
	import Alert from "#lib/components/alert.svelte";
	import CronJobFields from "#lib/components/cron-job-fields.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data, form } = $props();
	const job = $derived(data.job);

	let saving = $state(false);
</script>

<form
  id="cron-job-configuration"
  action="?/update"
  class="space-y-4"
  method="POST"
  use:enhance={enhanceToast({
    error: "Couldn't save the configuration.",
    loading: "Saving the configuration",
    onSettled: () => {
      saving = false;
    },
    onStart: () => {
      saving = true;
    },
    success: "Configuration saved.",
  })}
>
  {#if form?.error}
    <Alert>
      {form.error}
    </Alert>
  {/if}

  <CronJobFields
    hostAccess={data.hostAccess}
    remoteHosts={data.remoteHosts}
    values={{
      command: job.command,
      dockerSocket: job.dockerSocket,
      envVars: job.envVars ?? {},
      files: job.files,
      image: job.image,
      kind: job.kind,
      mounts: job.mounts,
      registryUrl: job.registryUrl,
      registryUsername: job.registryUsername,
      remoteHostId: job.remoteHostId,
      runAsUser: job.runAsUser,
      runtime: job.runtime,
      secretEnvKeys: job.secretEnvKeys,
      source: job.source,
      tag: job.tag,
    }}
    volumes={data.volumes}
  />

  <div class="flex justify-end">
    <SaveButton form="cron-job-configuration" pending={saving} />
  </div>
</form>
