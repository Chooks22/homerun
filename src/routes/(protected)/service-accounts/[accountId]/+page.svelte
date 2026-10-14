<script lang="ts">
	import { KeyRound, Plus, Trash2 } from "@lucide/svelte";
	import { onMount } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { SECRET_MASK } from "#lib/formatting.js";
	import { title } from "#lib/store/title.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set(`${data.account.name} · API keys`));

	let dialogOpen = $state(false);
	let pendingName = $state("");
	let pendingForm: HTMLFormElement | null = null;

	function isExpired(expiresAt: Date | null): boolean {
		return expiresAt !== null && new Date(expiresAt).getTime() < Date.now();
	}

	function formatDate(value: Date | null): string {
		return value ? new Date(value).toLocaleString() : "never";
	}

	function requestRevoke(event: MouseEvent, name: string) {
		pendingForm = (event.currentTarget as HTMLElement).closest("form");
		pendingName = name;
		dialogOpen = true;
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="The account's only credential. Send one as x-api-key, or run homerun gate session with it in CI."
    icon={KeyRound}
    title="API keys"
  >
    {#snippet trailing()}
      <Button
        href={resolve("/(protected)/service-accounts/[accountId]/keys/new", {
          accountId: data.account.id,
        })}
        size="sm"
      >
        <Plus class="size-4" />
        New API key
      </Button>
    {/snippet}
  </PanelHeader>
  <div class="p-5">
    {#if data.keys.length === 0}
      <EmptyState
        icon={KeyRound}
        subtitle="Mint one and store it as a secret in your CI."
        title="No API keys yet"
      />
    {:else}
      <div class="space-y-2.5">
        {#each data.keys as key (key.id)}
          <div class="border-border flex items-center gap-2 rounded-md border p-4">
            <div class="min-w-0 flex-1">
              <p class="text-text truncate text-sm font-medium">
                {key.name ?? "Unnamed key"}
                {#if isExpired(key.expiresAt)}
                  <span class="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[0.65rem] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    Expired
                  </span>
                {/if}
              </p>
              <p class="text-text-muted mt-0.5 truncate text-xs">
                {key.prefix ?? ""}{key.start ?? SECRET_MASK}…
              </p>
              <p class="text-text-subtle mt-0.5 text-xs">
                created {formatDate(key.createdAt)}
                · last used {formatDate(key.lastRequest)}
                · {key.expiresAt ? `expires ${formatDate(key.expiresAt)}` : "never expires"}
              </p>
            </div>
            <form
              action="?/revoke"
              method="POST"
              use:enhance={enhanceToast({
                error: "Couldn't revoke that key.",
                loading: "Revoking the key",
                success: "Key revoked.",
              })}
            >
              <input name="keyId" type="hidden" value={key.id} />
              <Button
                class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
                onclick={(event: MouseEvent) => requestRevoke(event, key.name ?? "this key")}
                size="icon-sm"
                title="Revoke"
                type="button"
                variant="ghost"
              >
                <Trash2 class="size-4" />
              </Button>
            </form>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

<ConfirmDialog
  bind:open={dialogOpen}
  confirmLabel="Revoke"
  description={`Revoke "${pendingName}"? Anything using this key will stop working immediately.`}
  onConfirm={() => pendingForm?.requestSubmit()}
  title="Revoke API key"
/>
