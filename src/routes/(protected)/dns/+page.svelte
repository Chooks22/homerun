<script lang="ts">
	import { ChevronRight, Globe, Plus, Trash2 } from "@lucide/svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import EmptyState from "#lib/components/empty-state.svelte";
	import { inputClass, labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import DomainLinkFields from "./domain-link-fields.svelte";

	const { data } = $props();

	let adding = $state(false);
	let name = $state("");
	const link = $state({
		autoRecords: true,
		dnsChallenge: false,
		connectionId: "",
		target: "",
		zone: "",
	});

	let removing = $state<{ id: string; name: string } | null>(null);
	let confirmingRemove = $state(false);
	let removeForm = $state<HTMLFormElement | undefined>();
</script>

<div class="space-y-6">
  <section class="panel rounded-md">
    <PanelHeader
      description="Domains you own. Linked to a provider zone, the records of services under them are handled for you, and you can edit every record here."
      icon={Globe}
      title="Domains"
    >
      {#snippet trailing()}
        <Button
          onclick={() => {
            adding = !adding;
          }}
          size="sm"
          variant="outline"
        >
          <Plus class="size-4" />
          Add domain
        </Button>
      {/snippet}
    </PanelHeader>

    {#if adding}
      <form
        action="?/addDomain"
        class="border-border space-y-4 border-b p-5"
        method="POST"
        use:enhance={enhanceToast({
          error: "Couldn't add the domain.",
          loading: "Adding the domain",
          success: "Domain added.",
        })}
      >
        <div>
          <label class={labelClass} for="domain-name">Domain</label>
          <input
            class="{inputClass} max-w-md"
            id="domain-name"
            name="name"
            placeholder="example.com"
            required
            bind:value={name}
          >
        </div>
        <DomainLinkFields
          baseDomain={data.baseDomain}
          connections={data.connections}
          onZonePicked={(zoneName) => {
            if (!name) {
              name = zoneName;
            }
          }}
          values={link}
        />
        <div class="flex justify-end gap-2">
          <Button
            onclick={() => {
              adding = false;
            }}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button type="submit">Add domain</Button>
        </div>
      </form>
    {/if}

    {#if data.domains.length === 0}
      <div class="p-5">
        <EmptyState
          icon={Globe}
          subtitle={data.connections.length === 0
            ? "Connect a DNS provider under Providers first, then add the domains it holds."
            : "Add a domain to manage its records from here."}
          title="No domains yet"
        />
      </div>
    {:else}
      <ul class="divide-border divide-y">
        {#each data.domains as domain (domain.id)}
          <li class="flex flex-wrap items-center gap-3 px-5 py-3">
            <a
              class="group flex min-w-0 flex-1 items-center gap-2"
              href={resolve("/(protected)/dns/domains/[domainId]", { domainId: domain.id })}
            >
              <Globe class="text-accent size-4 shrink-0" />
              <span class="min-w-0">
                <span class="text-text group-hover:text-accent block truncate text-sm font-medium">{domain.name}</span>
                <span class="text-text-muted block truncate text-xs">
                  {domain.connection
                    ? `${domain.connection.providerName} · ${domain.connection.name}${domain.zoneName ? ` · zone ${domain.zoneName}` : ""}`
                    : "Not managed by Homerun"}
                  · records point at {domain.target ?? data.baseDomain ?? "nothing yet"}
                  {domain.connection && domain.autoRecords ? ` · ${domain.managedRecords} managed` : ""}
                  {domain.connection && domain.dnsChallenge ? " · wildcard certificate over DNS" : ""}
                </span>
              </span>
              <ChevronRight class="text-text-subtle ml-auto size-4" />
            </a>
            <Button
              aria-label="Remove {domain.name}"
              onclick={() => {
                removing = { id: domain.id, name: domain.name };
                confirmingRemove = true;
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2 class="size-4" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<form
  action="?/deleteDomain"
  class="hidden"
  method="POST"
  bind:this={removeForm}
  use:enhance={enhanceToast({
    error: "Couldn't remove the domain.",
    loading: "Removing the domain",
    success: "Domain removed.",
  })}
>
  <input name="domainId" type="hidden" value={removing?.id ?? ""}>
</form>

<ConfirmDialog
  confirmLabel="Remove"
  description="Homerun stops managing its records. Nothing is deleted at the provider: the records it made stay until you remove them there."
  onConfirm={() => removeForm?.requestSubmit()}
  title="Remove {removing?.name ?? 'this domain'}?"
  bind:open={confirmingRemove}
/>
