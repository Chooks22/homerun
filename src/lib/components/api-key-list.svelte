<script lang="ts">
	import { KeyRound, Pencil, Trash2 } from "@lucide/svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { SECRET_MASK } from "#lib/formatting.js";
	import {
		areaLabel,
		type PermissionArea,
		type Permissions,
	} from "#lib/permissions.js";
	import type { ApiKeyView } from "#lib/server/api-keys.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	interface Props {
		emptySubtitle: string;
		keys: ApiKeyView[];
	}

	const { emptySubtitle, keys }: Props = $props();

	let dialogOpen = $state(false);
	let pendingName = $state("");
	let pendingForm: HTMLFormElement | null = null;

	function permissionSummary(permissions: Permissions): string {
		return Object.entries(permissions)
			.map(([area, level]) => `${areaLabel(area as PermissionArea)}: ${level}`)
			.join(", ");
	}

	function isExpired(expiresAt: Date | string | null): boolean {
		return expiresAt !== null && new Date(expiresAt).getTime() < Date.now();
	}

	function formatDate(value: Date | string | null): string {
		return value ? new Date(value).toLocaleString() : "never";
	}

	function requestRevoke(event: MouseEvent, name: string) {
		pendingForm = (event.currentTarget as HTMLElement).closest("form");
		pendingName = name;
		dialogOpen = true;
	}
</script>

{#if keys.length === 0}
  <EmptyState icon={KeyRound} subtitle={emptySubtitle} title="No API keys yet" />
{:else}
  <div class="space-y-2.5">
    {#each keys as key (key.id)}
      <div class="flex items-center gap-2 rounded-md border border-border p-4">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-text">
            {key.name ?? "Unnamed key"}
            {#if key.permissions === null}
              <span class="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[0.65rem] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                All permissions
              </span>
            {/if}
            {#if isExpired(key.expiresAt)}
              <span class="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[0.65rem] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                Expired
              </span>
            {/if}
            {#if !key.enabled}
              <span class="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[0.65rem] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                Disabled
              </span>
            {/if}
          </p>
          <p class="mt-0.5 truncate text-xs text-text-muted">
            {key.prefix ?? ""}{key.start ?? SECRET_MASK}…
          </p>
          {#if key.permissions}
            <p class="mt-0.5 truncate text-xs text-text-muted">
              {permissionSummary(key.permissions) || "No permissions"}
            </p>
          {/if}
          <p class="mt-0.5 text-xs text-text-subtle">
            created {formatDate(key.createdAt)}
            · last used {formatDate(key.lastRequest)}
            · {key.expiresAt
              ? `expires ${formatDate(key.expiresAt)}`
              : "never expires"}
          </p>
        </div>
        <Button
          href={resolve("/(protected)/profile/api-keys/[keyId]", { keyId: key.id })}
          size="icon-sm"
          title="Edit"
          variant="ghost"
        >
          <Pencil class="size-4" />
        </Button>
        <form
          action="?/revoke"
          method="POST"
          use:enhance={enhanceToast({
            error: "Couldn't revoke that key.",
            loading: "Revoking the key",
            success: "Key revoked.",
          })}
        >
          <input name="keyId" type="hidden" value={key.id}>
          <Button
            class="text-red-500 hover:bg-red-500/10 hover:text-red-500"
            onclick={(event: MouseEvent) =>
              requestRevoke(event, key.name ?? "this key")}
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

<ConfirmDialog
  bind:open={dialogOpen}
  confirmLabel="Revoke"
  description={`Revoke "${pendingName}"? Anything using this key will stop working immediately.`}
  onConfirm={() => pendingForm?.requestSubmit()}
  title="Revoke API key"
/>
