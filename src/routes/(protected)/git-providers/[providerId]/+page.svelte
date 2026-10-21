<script lang="ts">
	import { Link2, RefreshCw, Unlink, Webhook } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import CopyBox from "#lib/components/copy-box.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { disconnectGitProvider } from "#lib/remote/git-repos.remote.js";
	import { title } from "#lib/store/title.js";
	import { toastError } from "#lib/toast.js";
	import { refreshAll } from "$app/navigation";

	const { data } = $props();

	onMount(() => title.set(`${data.provider.name} · Connection`));

	let disconnecting = $state(false);

	async function disconnectCallback() {
		disconnecting = true;
		try {
			await disconnectGitProvider(data.provider.id);
			await refreshAll();
		} finally {
			disconnecting = false;
		}
	}

	function handleDisconnect() {
		return toast.promise(disconnectCallback(), {
			error: (error) => toastError(error, "Couldn't disconnect."),
			loading: "Disconnecting",
			success: "Disconnected.",
		});
	}

	function formatDate(value: Date): string {
		return new Date(value).toLocaleString();
	}
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Your own account on this provider: it lists your repos, clones private ones and registers push webhooks."
      icon={Link2}
      title="Your connection"
    />
    <div class="flex flex-wrap items-center justify-between gap-4 p-5">
      {#if data.connection}
        <div>
          <p class="text-text text-sm font-medium">
            Connected as {data.connection.username}
          </p>
          <p class="text-text-subtle mt-0.5 text-xs">
            since {formatDate(data.connection.connectedAt)}
            · last refreshed {formatDate(data.connection.updatedAt)}
          </p>
          <p class="text-text-muted mt-1 text-xs">
            Repos missing or webhooks failing? Reconnect to authorize again,
            or to switch to another account.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          {#if data.provider.enabled}
            <Button href={data.connectUrl} size="sm" variant="outline">
              <RefreshCw class="size-4" />
              Reconnect
            </Button>
          {/if}
          <Button
            disabled={disconnecting}
            onclick={handleDisconnect}
            size="sm"
            type="button"
            variant="outline"
          >
            <Unlink class="size-4" />
            Disconnect
          </Button>
        </div>
      {:else if data.provider.enabled}
        <p class="text-text-muted text-sm">You haven't connected an account yet.</p>
        <Button href={data.connectUrl} size="sm">
          <Link2 class="size-4" />
          Connect
        </Button>
      {:else}
        <p class="text-text-muted text-sm">
          This provider is disabled, so nobody can connect to it until it's
          enabled again.
        </p>
      {/if}
    </div>
  </section>

  {#if data.canWrite && data.provider.kind !== "github"}
    <section class="panel rounded-md">
      <PanelHeader
        description="Give this to the OAuth App registered on the provider's own site."
        icon={Webhook}
        title="Callback URL"
      />
      <div class="p-5">
        <CopyBox class="bg-surface-3" label="the callback URL" value={data.callbackUrl} />
      </div>
    </section>
  {/if}
</div>
