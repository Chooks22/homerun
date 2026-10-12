<script lang="ts">
	import { Check } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import { authClient } from "#lib/auth-client.js";
	import AuthShell from "#lib/components/auth-shell.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import Spinner from "#lib/components/ui/spinner/spinner.svelte";
	import { title } from "#lib/store/title.js";
	import { toastError } from "#lib/toast.js";

	const { data } = $props();

	let pending = $state<"allow" | "deny" | null>(null);

	onMount(() => title.set(`Allow ${data.appName}?`));

	async function consentCallback(accept: boolean) {
		pending = accept ? "allow" : "deny";
		try {
			const { data: result, error } = await authClient.oauth2.consent({
				accept,
			});
			if (error) {
				throw new Error(error.message ?? "Couldn't record your answer.");
			}
			const target =
				result && "url" in result && typeof result.url === "string"
					? result.url
					: null;
			if (target) {
				window.location.assign(target);
			}
		} catch (err) {
			pending = null;
			throw err;
		}
	}

	function handleConsent(accept: boolean) {
		return toast.promise(consentCallback(accept), {
			error: (err) => toastError(err, "Couldn't record your answer."),
			loading: accept ? `Allowing ${data.appName}` : "Declining",
		});
	}
</script>

<AuthShell
  eyebrow="Sign in with Homerun"
  heading="Allow {data.appName}?"
  subheading="{data.appName} wants to sign you in with your Homerun account."
>
  <div class="space-y-5">
    <div>
      <p class="text-text-muted mb-2 text-sm">It will be able to see:</p>
      <ul class="space-y-2">
        {#each data.scopes as scope (scope)}
          <li class="text-text flex items-start gap-2 text-sm">
            <Check class="text-accent mt-0.5 size-4 shrink-0" />
            {scope}
          </li>
        {/each}
      </ul>
    </div>

    {#if data.discoveredFrom}
      <p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
        This app described itself from <strong>{data.discoveredFrom}</strong>:
        its name is whatever that site says. Only allow it if you started this
        from an app you trust that lives there.
      </p>
    {/if}

    <p class="text-text-subtle text-xs">Signed in as {data.signedInAs}</p>

    <div class="flex flex-col gap-2 sm:flex-row-reverse">
      <Button
        class="h-10 flex-1"
        disabled={pending !== null}
        onclick={() => handleConsent(true)}
      >
        {#if pending === "allow"}
          <Spinner />
        {/if}
        Allow
      </Button>
      <Button
        class="h-10 flex-1"
        disabled={pending !== null}
        onclick={() => handleConsent(false)}
        variant="outline"
      >
        {#if pending === "deny"}
          <Spinner />
        {/if}
        Decline
      </Button>
    </div>
  </div>
</AuthShell>
