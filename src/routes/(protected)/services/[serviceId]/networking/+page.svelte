<script lang="ts">
	import { onMount } from "svelte";
	import { title } from "#lib/store/title.js";
	import { visibleIn } from "#lib/ui-mode.js";
	import CacheSection from "./cache-section.svelte";
	import DomainsSection from "./domains-section.svelte";
	import NetworkSection from "./network-section.svelte";
	import PublishedPortsSection from "./published-ports-section.svelte";
	import SslSection from "./ssl-section.svelte";

	const { data, form } = $props();
	const svc = $derived(data.service);

	onMount(() => title.set(`${svc.name} · Networking`));

	let submitting = $state(false);
</script>

<div class="space-y-6">
  <DomainsSection
    baseDomain={data.baseDomain}
    serviceDomain={data.serviceDomain}
    stackSlug={data.stackSlug}
    {svc}
    bind:submitting
  />
  <SslSection
    baseDomain={data.baseDomain}
    behindPangolin={data.behindPangolin}
    certResolver={data.certResolver}
    {svc}
    bind:submitting
  />
  <NetworkSection
    collapseNetworkMode={!visibleIn(data.uiMode, "service/networking#network-mode") &&
    svc.networkMode === "bridge"}
    errors={form?.errors as Record<string, string[]> | undefined}
    serviceDomain={data.serviceDomain}
    submittedValues={form?.portsValues as Record<string, string> | undefined}
    {svc}
  />
  {#if visibleIn(data.uiMode, "service/networking#http-cache") || svc.httpCacheTtl !== null}
    <CacheSection available={data.httpCacheAvailable} {svc} />
  {/if}
  {#if visibleIn(data.uiMode, "service/networking#published-ports") || svc.publishedPorts.length > 0}
    <PublishedPortsSection {svc} />
  {/if}
</div>
