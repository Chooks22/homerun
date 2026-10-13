<script lang="ts">
	import { Cpu, MemoryStick, Network } from "@lucide/svelte";
	import { onMount } from "svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import UsageChart from "#lib/components/usage-chart.svelte";
	import { formatBytes } from "#lib/formatting.js";
	import { workstationLiveStats } from "#lib/remote/workstations.remote.js";
	import { title } from "#lib/store/title.js";

	const { data } = $props();
	const ws = $derived(data.workstation);

	onMount(() => title.set(`${ws.name} · Observability`));

	const live = $derived(workstationLiveStats(ws.id));
	const sample = $derived(live.current ?? null);

	onMount(() => {
		const timer = setInterval(() => {
			void workstationLiveStats(ws.id).refresh();
		}, 5000);
		return () => clearInterval(timer);
	});

	const cpuCap = $derived(ws.cpuLimit ? ws.cpuLimit * 100 : null);
	const memCap = $derived(ws.memoryLimitMb ?? sample?.memLimitMb ?? null);

	function megabytes(value: number): string {
		return value < 1024
			? `${value.toFixed(0)} MB`
			: `${(value / 1024).toFixed(1)} GB`;
	}

	function share(value: number, cap: number | null): number {
		return cap ? Math.min(100, (value / cap) * 100) : 0;
	}
</script>

<div class="space-y-4">
  <section class="panel rounded-xl">
    <PanelHeader
      description="Read from the container every 5 seconds while this page is open."
      title="Right now"
    />
    <div class="p-5">
      {#if live.error}
        <p class="text-text-muted text-xs">Couldn't read the workstation's stats.</p>
      {:else if !live.ready}
        <Skeleton class="h-20 w-full" />
      {:else if !sample}
        <p class="text-text-muted text-xs">
          Not running. Start it from the Overview to see its resource use.
        </p>
      {:else}
        <div class="grid gap-4 sm:grid-cols-3">
          {#each [
            {
              cap: cpuCap,
              detail: cpuCap ? `of ${ws.cpuLimit} cores` : "no CPU limit",
              icon: Cpu,
              label: "CPU",
              text: `${sample.cpuPercent.toFixed(1)}%`,
              value: sample.cpuPercent,
            },
            {
              cap: memCap,
              detail: memCap ? `of ${megabytes(memCap)}` : "no memory limit",
              icon: MemoryStick,
              label: "Memory",
              text: megabytes(sample.memUsedMb),
              value: sample.memUsedMb,
            },
          ] as metric (metric.label)}
            <div class="border-border space-y-2 rounded-lg border p-4">
              <div class="text-text-muted flex items-center gap-2 text-xs">
                <metric.icon class="size-4" />
                {metric.label}
              </div>
              <p class="tech text-text text-xl font-semibold">{metric.text}</p>
              {#if metric.cap}
                <div class="bg-surface-2 h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    class="h-full rounded-full {share(metric.value, metric.cap) >= 90
                    ? 'bg-red-500'
                    : 'bg-accent'}"
                    style:width="{share(metric.value, metric.cap)}%"
                  ></div>
                </div>
              {/if}
              <p class="text-text-subtle text-xs">{metric.detail}</p>
            </div>
          {/each}
          <div class="border-border space-y-2 rounded-lg border p-4">
            <div class="text-text-muted flex items-center gap-2 text-xs">
              <Network class="size-4" />
              Network since start
            </div>
            <p class="tech text-text text-xl font-semibold">
              ↓ {formatBytes(sample.netRxBytes)}
            </p>
            <p class="text-text-subtle text-xs">↑ {formatBytes(sample.netTxBytes)} sent</p>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <UsageChart title="History" workstationId={ws.id} />
</div>
