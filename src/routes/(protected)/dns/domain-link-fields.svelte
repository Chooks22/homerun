<script lang="ts">
	import CheckBox from "#lib/components/check-box.svelte";
	import { inputClass, labelClass } from "#lib/components/form-styles.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import type { DnsConnectionSummary } from "#lib/dto/dns-connection-dto.js";
	import { getConnectionZones } from "#lib/remote/dns.remote.js";

	interface Props {
		baseDomain: string;
		connections: DnsConnectionSummary[];
		onZonePicked?: (zoneName: string) => void;
		values: {
			autoRecords: boolean;
			connectionId: string;
			dnsChallenge: boolean;
			target: string;
			zone: string;
		};
	}

	const { baseDomain, connections, onZonePicked, values }: Props = $props();

	const zones = $derived(
		values.connectionId ? getConnectionZones(values.connectionId) : null,
	);
	const connectionLabel = $derived(
		connections.find((connection) => connection.id === values.connectionId)
			?.name ?? "Not managed by Homerun",
	);
	const zoneLabel = $derived(
		values.zone ? (values.zone.split("|")[1] ?? values.zone) : "Pick a zone",
	);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <div>
    <p class={labelClass}>DNS provider</p>
    <SelectRoot
      name="connectionId"
      onValueChange={() => {
        values.zone = "";
      }}
      type="single"
      bind:value={values.connectionId}
    >
      <SelectTrigger aria-label="DNS provider">{connectionLabel}</SelectTrigger>
      <SelectContent>
        <SelectItem label="Not managed by Homerun" value="" />
        {#each connections as connection (connection.id)}
          <SelectItem label="{connection.name} ({connection.providerName})" value={connection.id} />
        {/each}
      </SelectContent>
    </SelectRoot>
    <p class="text-text-subtle mt-1.5 text-xs">
      Without one, Homerun lists the domain but you add its records yourself.
    </p>
  </div>

  {#if values.connectionId}
    <div>
      <p class={labelClass}>Zone</p>
      {#if !zones || zones.loading}
        <p class="text-text-muted text-sm">Listing the zones…</p>
      {:else if zones.current?.error}
        <p class="text-sm text-red-500">{zones.current.error}</p>
      {:else}
        <SelectRoot
          name="zone"
          onValueChange={(value) => onZonePicked?.(value.split("|")[1] ?? "")}
          type="single"
          bind:value={values.zone}
        >
          <SelectTrigger aria-label="Zone">{zoneLabel}</SelectTrigger>
          <SelectContent>
            {#each zones.current?.zones ?? [] as zone (zone.id)}
              <SelectItem label={zone.name} value="{zone.id}|{zone.name}" />
            {/each}
          </SelectContent>
        </SelectRoot>
        <p class="text-text-subtle mt-1.5 text-xs">The zone at the provider the domain's records live in.</p>
      {/if}
    </div>
  {/if}

  <div>
    <label class={labelClass} for="domain-target">Records point at</label>
    <input
      class={inputClass}
      id="domain-target"
      name="target"
      placeholder={baseDomain || "203.0.113.10"}
      bind:value={values.target}
    >
    <p class="text-text-subtle mt-1.5 text-xs">
      This server's IP (an A or AAAA record) or a hostname that already reaches
      it (a CNAME). Blank uses the base domain{baseDomain ? `, ${baseDomain}` : ""}.
    </p>
  </div>

  <CheckBox
    helperText="Create, fix and remove the record of every service hostname under this domain, as services are deployed and deleted."
    id="autoRecords"
    label="Manage service records"
    name="autoRecords"
    bind:checked={values.autoRecords}
  />

  {#if values.connectionId}
    <CheckBox
      helperText="Traefik proves control of the domain with a TXT record Homerun writes through this provider, and gets one wildcard certificate for it instead of one per hostname. Works behind a proxy like Cloudflare's, where HTTP challenges fail. Services pick it up on their next deploy."
      id="dnsChallenge"
      label="Issue certificates through DNS (DNS-01)"
      name="dnsChallenge"
      bind:checked={values.dnsChallenge}
    />
  {/if}
</div>
