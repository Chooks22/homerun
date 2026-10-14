<script lang="ts">
	import { onMount } from "svelte";
	import AuditLogTable from "#lib/components/audit-log-table.svelte";
	import { title } from "#lib/store/title.js";

	const { data } = $props();

	onMount(() => title.set(`${data.account.name} · Activity`));
</script>

<AuditLogTable entries={data.entries} />
