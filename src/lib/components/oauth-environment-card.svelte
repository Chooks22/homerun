<script lang="ts">
	import { KeyRound, Laptop, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import { inputClass } from "#lib/components/form-styles.js";
	import OauthEnvironmentFields, {
		type OauthEnvironmentFieldValues,
	} from "#lib/components/oauth-environment-fields.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import type { OauthClientSecretSummary } from "#lib/dto/oauth-client-secret-dto.js";
	import { formatDate, SECRET_MASK, timeAgo } from "#lib/formatting.js";
	import type { OauthClientEnvironment } from "#lib/server/db/schema.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		canDelete: boolean;
		confidential: boolean;
		environment: OauthClientEnvironment;
		secrets: OauthClientSecretSummary[];
	}

	const { canDelete, confidential, environment, secrets }: Props = $props();

	const values = $state<OauthEnvironmentFieldValues>(
		untrack(() => ({
			allowedOrigins:
				environment.allowedOrigins.length > 0
					? [...environment.allowedOrigins]
					: [""],
			allowLocalhost: environment.allowLocalhost,
			name: environment.name,
			redirectUris: [...environment.redirectUris],
		})),
	);

	let saving = $state(false);
	let confirmingDelete = $state(false);
	let revoking = $state<OauthClientSecretSummary | null>(null);
	let confirmingRevoke = $state(false);
	let deleteForm = $state<HTMLFormElement | undefined>();
	let revokeForm = $state<HTMLFormElement | undefined>();
	let label = $state("");
</script>

<section class="panel rounded-md">
  <div class="panel-head">
    <div class="flex min-w-0 items-center gap-2">
      <h2 class="text-text truncate text-sm font-semibold">{environment.name}</h2>
      {#if environment.allowLocalhost}
        <span class="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-amber-600 dark:text-amber-400">
          <Laptop class="size-3" />
          localhost allowed
        </span>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if canDelete}
        <Button
          aria-label="Delete the {environment.name} environment"
          onclick={() => {
            confirmingDelete = true;
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2 class="size-4" />
        </Button>
      {/if}
      <SaveButton form="oauth-environment-{environment.id}" pending={saving} />
    </div>
  </div>

  <form
    id="oauth-environment-{environment.id}"
    action="?/updateEnvironment"
    class="space-y-5 p-5"
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
      success: "Environment saved.",
    })}
  >
    <input name="environmentId" type="hidden" value={environment.id}>
    <OauthEnvironmentFields idPrefix={environment.id} {values} />
  </form>

  {#if confidential}
    <div class="border-border border-t p-5">
      <h3 class="text-text flex items-center gap-1.5 text-sm font-semibold">
        <KeyRound class="text-accent size-4" />
        Client secrets
      </h3>
      <p class="text-text-muted mt-0.5 mb-3 text-xs">
        Each works on its own and only for this environment's callbacks.
        Rotate without downtime: add a new one, switch the app over, revoke
        the old one.
      </p>
      {#if secrets.length === 0}
        <p class="text-text-subtle mb-3 text-xs">
          No secret yet: the app can't sign anyone in from this environment.
        </p>
      {:else}
        <ul class="divide-border border-border mb-3 divide-y rounded-md border">
          {#each secrets as secret (secret.id)}
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span class="text-text min-w-0 flex-1 truncate text-sm">{secret.label}</span>
              <code class="text-text-muted font-mono text-xs">
                {SECRET_MASK}{secret.hint}
              </code>
              <span class="text-text-subtle text-xs" title={formatDate(secret.createdAt)}>
                created {timeAgo(secret.createdAt)}
              </span>
              <span class="text-text-subtle text-xs">
                {secret.lastUsedAt ? `used ${timeAgo(secret.lastUsedAt)}` : "never used"}
              </span>
              <Button
                onclick={() => {
                  revoking = secret;
                  confirmingRevoke = true;
                }}
                size="sm"
                variant="ghost"
              >
                Revoke
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
      <form
        action="?/issueSecret"
        class="flex flex-wrap items-center gap-2"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't create the secret.",
          loading: "Creating a secret",
          onSuccess: () => {
            label = "";
          },
          success: "Secret created. Copy it from the top of the page.",
        })}
      >
        <input name="environmentId" type="hidden" value={environment.id}>
        <input
          aria-label="Secret label"
          class="{inputClass} max-w-xs"
          maxlength="64"
          name="label"
          placeholder="Label, e.g. Deployed on k8s"
          bind:value={label}
        >
        <Button type="submit" variant="outline">New secret</Button>
      </form>
    </div>
  {/if}
</section>

<form
  action="?/deleteEnvironment"
  method="POST"
  bind:this={deleteForm}
  use:enhance={enhanceToast({
    error: "Couldn't delete the environment.",
    loading: "Deleting the environment",
    success: "Environment deleted.",
  })}
>
  <input name="environmentId" type="hidden" value={environment.id}>
</form>

<form
  action="?/revokeSecret"
  method="POST"
  bind:this={revokeForm}
  use:enhance={enhanceToast({
    error: "Couldn't revoke the secret.",
    loading: "Revoking the secret",
    success: "Secret revoked.",
  })}
>
  <input name="secretId" type="hidden" value={revoking?.id ?? ""}>
</form>

<ConfirmDialog
  confirmLabel="Delete environment"
  confirmPhrase={environment.name}
  description="Its callback URLs stop being accepted and its secrets stop working at once."
  onConfirm={() => deleteForm?.requestSubmit()}
  title="Delete the {environment.name} environment?"
  bind:open={confirmingDelete}
/>

<ConfirmDialog
  confirmLabel="Revoke secret"
  description="Anything still using it can't sign anyone in from the moment you confirm."
  onConfirm={() => revokeForm?.requestSubmit()}
  title="Revoke {revoking?.label ?? 'this secret'}?"
  bind:open={confirmingRevoke}
/>
