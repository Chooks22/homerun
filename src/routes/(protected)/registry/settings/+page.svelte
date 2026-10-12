<script lang="ts">
	import { toast } from "svelte-sonner";
	import Alert from "#lib/components/alert.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import CopyBox from "#lib/components/copy-box.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import SelfTestChecks from "#lib/components/self-test-checks.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { formatBytes } from "#lib/formatting.js";
	import { queuedJobToast } from "#lib/job-toast.js";
	import type { RegistryCheck } from "#lib/registry-self-test.js";
	import { testRegistry } from "#lib/remote/registry.remote.js";
	import { toastError } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	const { data } = $props();

	let publicHost = $state("");
	$effect(() => {
		publicHost = data.status.publicHost ?? "";
	});
	let authEnabled = $state(false);
	$effect(() => {
		authEnabled = data.status.authEnabled;
	});
	let savingAuth = $state(false);

	let checks = $state<RegistryCheck[] | null>(null);
	let testing = $state(false);
	let publishing = $state(false);

	async function selfTestCallback() {
		testing = true;
		try {
			checks = await testRegistry();
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
			loading: "Testing the registry",
			success: "Every check passed.",
		});
	}
</script>

<section class="border-border bg-surface-1 mb-6 rounded-lg border p-4">
  <div class="flex items-center justify-between gap-4">
    <h2 class="text-text text-sm font-medium">Status</h2>
    <Button
      disabled={testing}
      onclick={handleSelfTest}
      size="sm"
      variant="outline"
    >
      Self-test
    </Button>
  </div>
  <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
    <div>
      <dt class="text-text-muted text-xs">Container</dt>
      <dd class="text-text mt-0.5">
        {data.status.running ? "Running" : "Not running"}
      </dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Disk used</dt>
      <dd class="text-text mt-0.5">
        {data.status.sizeBytes === null
          ? "Unknown"
          : formatBytes(data.status.sizeBytes)}
      </dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Internal address</dt>
      <dd class="text-text mt-0.5 font-mono text-xs">
        {data.status.internalEndpoint}
      </dd>
    </div>
    <div>
      <dt class="text-text-muted text-xs">Tokens</dt>
      <dd class="text-text mt-0.5">{data.status.tokenCount}</dd>
    </div>
  </dl>
  {#if checks}
    <SelfTestChecks checks={checks} class="border-border mt-4 border-t pt-4" />
  {/if}
</section>

<section class="border-border bg-surface-1 mb-6 rounded-lg border p-4">
  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <h2 class="text-text text-sm font-medium">Require authentication</h2>
      <p class="text-text-muted mt-1 text-sm">
        Turns on the registry's htpasswd auth, so only a token from the Tokens
        tab can pull or push. Homerun mints itself a reserved token at the same
        time, so its own scans and deploys keep working.
      </p>
    </div>
    <SaveButton
      disabled={authEnabled === data.status.authEnabled}
      form="registry-auth"
      pending={savingAuth}
    />
  </div>
  <form
    id="registry-auth"
    class="mt-3"
    action="?/setAuth"
    method="POST"
    use:enhance={queuedJobToast({
      error: "Couldn't change the registry's auth.",
      loading: "Queueing the change",
      onSettled: () => {
        savingAuth = false;
      },
      onStart: () => {
        savingAuth = true;
      },
      success: "The registry's auth is being changed in the background.",
    })}
  >
    <CheckBox
      helperText="Applies on save : the registry container is recreated with its auth file."
      id="registryAuthEnabled"
      label="Require a token"
      name="enabled"
      bind:checked={authEnabled}
    />
  </form>
</section>

<section class="border-border bg-surface-1 rounded-lg border p-4">
  <div class="flex items-center justify-between gap-4">
    <h2 class="text-text text-sm font-medium">Publish it</h2>
    <SaveButton
      disabled={!data.status.authEnabled}
      form="registry-public-host"
      pending={publishing}
    />
  </div>
  <p class="text-text-muted mt-1 mb-3 text-sm">
    Routes the registry through Traefik at a hostname of your own, so other
    machines can push to it. Point that hostname's DNS at this host first. Auth
    has to be on : an open registry anyone can push to is never what you want.
  </p>

  {#if !data.status.authEnabled}
    <Alert class="mb-3" title="Turn auth on first.">
      Publishing is refused while the registry accepts anonymous writes.
    </Alert>
  {/if}

  <form
    id="registry-public-host"
    action="?/setPublicHost"
    method="POST"
    use:enhance={queuedJobToast({
      error: "Couldn't publish the registry.",
      loading: "Queueing the change",
      onSettled: () => {
        publishing = false;
      },
      onStart: () => {
        publishing = true;
      },
      success: "The registry's route is being reconfigured in the background.",
    })}
  >
    <Input
      autocomplete="off"
      bind:value={publicHost}
      class="max-w-sm"
      name="publicHost"
      placeholder={data.suggestedHost || "registry.example.com"}
    />
  </form>

  {#if data.status.publicHost}
    <div class="mt-4">
      <p class="text-text-muted mb-2 text-sm">Push to it with:</p>
      <CopyBox
        value={`docker login ${data.status.publicHost}\ndocker tag myapp:latest ${data.status.publicHost}/myapp:latest\ndocker push ${data.status.publicHost}/myapp:latest`}
      />
    </div>
  {/if}
</section>
