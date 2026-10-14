<script lang="ts">
	import { ArrowLeft } from "@lucide/svelte";
	import { onMount } from "svelte";
	import AuditLogTable from "#lib/components/audit-log-table.svelte";
	import { title } from "#lib/store/title.js";
	import { resolve } from "$app/paths";

	const { data } = $props();

	onMount(() => title.set("Service account activity"));
</script>

<div class="p-5 md:p-6">
  <a
    class="text-text-muted hover:text-text mb-5 inline-flex items-center gap-1 text-sm"
    href={resolve("service-accounts")}
  >
    <ArrowLeft class="size-4" />
    All service accounts
  </a>
  <div class="mb-6">
    <h1 class="text-text text-lg font-semibold tracking-tight">Activity</h1>
    <p class="text-text-muted mt-1 text-sm">
      The latest uses of every service account's keys, deleted accounts
      included.
    </p>
  </div>
  <AuditLogTable entries={data.entries} showActor />
</div>
