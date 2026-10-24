<script lang="ts">
	import { Globe, Pencil, Plus, Server, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import ConfirmDialog from "#lib/components/confirm-dialog.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import DomainLinkFields from "../../domain-link-fields.svelte";
	import RecordForm from "./record-form.svelte";

	const { data } = $props();

	const link = $state(
		untrack(() => ({
			autoRecords: data.domain.autoRecords,
			dnsChallenge: data.domain.dnsChallenge,
			connectionId: data.domain.connectionId ?? "",
			target: data.domain.target ?? "",
			zone: data.domain.zoneId
				? `${data.domain.zoneId}|${data.domain.zoneName ?? data.domain.name}`
				: "",
		})),
	);

	interface EditedRecord {
		content: string;
		id: string;
		name: string;
		priority: number | null;
		ttl: number | null;
		type: string;
	}

	let savingDomain = $state(false);
	let editing = $state<EditedRecord | "new" | null>(null);
	let removing = $state<EditedRecord | null>(null);
	let confirmingRemove = $state(false);
	let removeForm = $state<HTMLFormElement | undefined>();

	/** A record name as shown: `@` for the apex, else relative to the domain. */
	function shortName(name: string): string {
		return name === data.domain.name
			? "@"
			: name.replace(
					new RegExp(`\\.${data.domain.name.replaceAll(".", "\\.")}$`),
					"",
				);
	}
</script>

<div class="space-y-6">
  <div class="flex items-center gap-3">
    <span class="bg-accent/10 text-accent flex size-10 items-center justify-center rounded-lg">
      <Globe class="size-5" />
    </span>
    <div>
      <h2 class="text-text text-lg font-semibold">{data.domain.name}</h2>
      <p class="text-text-muted text-xs">Service records point at {data.target ?? "nothing yet"}.</p>
    </div>
  </div>

  <section class="panel rounded-md">
    <PanelHeader description="Where the domain's records live, and what services' records point at." title="Domain">
      {#snippet trailing()}
        <SaveButton form="domain-settings" pending={savingDomain} />
      {/snippet}
    </PanelHeader>
    <form
      id="domain-settings"
      action="?/updateDomain"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the domain.",
        loading: "Saving the domain",
        onSettled: () => {
          savingDomain = false;
        },
        onStart: () => {
          savingDomain = true;
        },
        success: "Domain saved.",
      })}
    >
      <DomainLinkFields baseDomain={data.baseDomain} connections={data.connections} values={link} />
    </form>
  </section>

  {#if data.domain.connectionId}
    <section class="panel rounded-md">
      <PanelHeader description="Every record under this domain at the provider. Managed ones are the records Homerun created for services." title="Records">
        {#snippet trailing()}
          <form
            action="?/pointAtServer"
            method="POST"
            use:enhance={enhanceToast({
              error: "Couldn't point the domain at the server.",
              loading: "Creating the records",
              success: (result) =>
                result && "pointed" in result && typeof result.pointed === "string" ? result.pointed : "Done.",
            })}
          >
            <Button size="sm" type="submit" variant="outline">
              <Server class="size-4" />
              Point at this server
            </Button>
          </form>
          <Button
            onclick={() => {
              editing = "new";
            }}
            size="sm"
            variant="outline"
          >
            <Plus class="size-4" />
            Add record
          </Button>
        {/snippet}
      </PanelHeader>

      {#if editing}
        <RecordForm
          domainName={data.domain.name}
          onDone={() => {
            editing = null;
          }}
          record={editing === "new" ? null : editing}
          shortName={editing === "new" ? "" : shortName(editing.name)}
        />
      {/if}

      {#await data.records}
        <div class="space-y-2 p-5">
          <Skeleton class="h-8 w-full" />
          <Skeleton class="h-8 w-full" />
        </div>
      {:then result}
        {#if result.error}
          <p class="p-5 text-sm text-red-500">Couldn't list the records: {result.error}</p>
        {:else if result.records.length === 0}
          <p class="text-text-muted p-5 text-sm">No records under this domain yet.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-border text-text-muted border-b text-left text-xs uppercase">
                  <th class="px-5 py-2 font-medium">Name</th>
                  <th class="px-3 py-2 font-medium">Type</th>
                  <th class="px-3 py-2 font-medium">Value</th>
                  <th class="px-3 py-2 font-medium">TTL</th>
                  <th class="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each result.records as record (record.id)}
                  <tr class="border-border/60 border-b last:border-0">
                    <td class="px-5 py-2 font-mono text-xs">
                      {shortName(record.name)}
                      {#if record.managed}
                        <span class="bg-accent/10 text-accent ml-1 rounded px-1.5 py-0.5 font-sans text-[0.6875rem]">managed</span>
                      {/if}
                    </td>
                    <td class="px-3 py-2 font-mono text-xs">{record.type}</td>
                    <td class="max-w-md truncate px-3 py-2 font-mono text-xs" title={record.content}>
                      {record.priority !== null ? `${record.priority} ` : ""}{record.content}
                    </td>
                    <td class="text-text-muted px-3 py-2 text-xs">{record.ttl ?? "auto"}</td>
                    <td class="px-5 py-2 text-right whitespace-nowrap">
                      {#if ["A", "AAAA", "CNAME", "TXT", "MX", "CAA"].includes(record.type)}
                        <Button
                          aria-label="Edit {record.name}"
                          onclick={() => {
                            editing = record;
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Pencil class="size-3.5" />
                        </Button>
                        <Button
                          aria-label="Delete {record.name}"
                          onclick={() => {
                            removing = record;
                            confirmingRemove = true;
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash2 class="size-3.5" />
                        </Button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/await}
    </section>
  {/if}
</div>

<form
  action="?/deleteRecord"
  class="hidden"
  method="POST"
  bind:this={removeForm}
  use:enhance={enhanceToast({ error: "Couldn't delete the record.", loading: "Deleting the record", success: "Record deleted." })}
>
  <input name="recordId" type="hidden" value={removing?.id ?? ""}>
</form>

<ConfirmDialog
  confirmLabel="Delete record"
  description="It's deleted at the provider right away. Anything relying on it stops resolving once caches expire."
  onConfirm={() => removeForm?.requestSubmit()}
  title="Delete {removing ? `${removing.type} ${removing.name}` : 'this record'}?"
  bind:open={confirmingRemove}
/>
