<script lang="ts">
	import { onMount } from "svelte";
	import Skeleton from "#lib/components/skeleton.svelte";
	import { formatBytes } from "#lib/formatting.js";
	import { getStatHistory } from "#lib/remote/stats.remote.js";

	interface Props {
		/** null charts the host itself. */
		serviceId?: string | null;
		title?: string;
		/** Charts a workstation instead, when set. */
		workstationId?: string | null;
	}

	const {
		serviceId = null,
		title = "Resource usage",
		workstationId = null,
	}: Props = $props();

	const RANGES = [
		["live", "Live"],
		["hour", "1h"],
		["day", "24h"],
		["week", "7d"],
		["month", "30d"],
		["year", "1y"],
		["all", "All"],
	] as const;

	type Range = (typeof RANGES)[number][0];
	type Metric = "cpu" | "memory" | "network";

	let range = $state<Range>("hour");
	let metric = $state<Metric>("cpu");

	const history = $derived(getStatHistory({ range, serviceId, workstationId }));
	const points = $derived(history.current ?? []);

	// Live refreshes on the same 5s beat the Host Resources panel polls at;
	// every other range is historical and only reloads when it changes.
	onMount(() => {
		const timer = setInterval(() => {
			if (range === "live") {
				void getStatHistory({
					range: "live",
					serviceId,
					workstationId,
				}).refresh();
			}
		}, 5000);
		return () => clearInterval(timer);
	});

	const series = $derived(
		points.map((point) => {
			if (metric === "cpu") {
				return point.cpuPercent;
			}
			if (metric === "memory") {
				return point.memUsedMb;
			}
			return point.netRxBytesPerSec + point.netTxBytesPerSec;
		}),
	);

	const peak = $derived(Math.max(...series, metric === "cpu" ? 100 : 1));
	const latest = $derived(series.at(-1) ?? 0);

	function label(value: number): string {
		if (metric === "cpu") {
			return `${value.toFixed(0)}%`;
		}
		if (metric === "memory") {
			return `${value < 1024 ? `${value.toFixed(0)} MB` : `${(value / 1024).toFixed(1)} GB`}`;
		}
		return `${formatBytes(value)}/s`;
	}

	/** An SVG path over a 0..100 × 0..40 viewBox, so the chart scales with its container. */
	const path = $derived.by(() => {
		if (series.length === 0) {
			return "";
		}
		if (series.length === 1) {
			const y = 40 - (series[0] / peak) * 38;
			return `M0,${y} L100,${y}`;
		}
		return series
			.map((value, i) => {
				const x = (i / (series.length - 1)) * 100;
				const y = 40 - (value / peak) * 38;
				return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
			})
			.join(" ");
	});

	const area = $derived(path ? `${path} L100,40 L0,40 Z` : "");

	const spanLabel = $derived.by(() => {
		const first = points.at(0)?.at;
		if (!first) {
			return "";
		}
		return new Intl.DateTimeFormat(undefined, {
			day: range === "live" || range === "hour" ? undefined : "numeric",
			hour: range === "year" || range === "all" ? undefined : "2-digit",
			minute: range === "year" || range === "all" ? undefined : "2-digit",
			month: range === "live" || range === "hour" ? undefined : "short",
		}).format(first);
	});
</script>

<section class="panel flex flex-col rounded-xl">
  <div class="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
    <div class="flex items-baseline gap-3">
      <h2 class="eyebrow">{title}</h2>
      <span class="tech text-text text-lg font-semibold">{label(latest)}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <div class="bg-surface-2 flex rounded-lg p-0.5">
        {#each [["cpu", "CPU"], ["memory", "Memory"], ["network", "Traffic"]] as const as [value, text] (value)}
          <button
            class="rounded-md px-2 py-1 text-xs font-medium transition-colors {metric === value
            ? 'bg-surface text-text shadow-sm'
            : 'text-text-muted hover:text-text'}"
            onclick={() => {
              metric = value;
            }}
            type="button"
          >
            {text}
          </button>
        {/each}
      </div>
      <div class="bg-surface-2 flex rounded-lg p-0.5">
        {#each RANGES as [value, text] (value)}
          <button
            class="rounded-md px-2 py-1 text-xs font-medium transition-colors {range === value
            ? 'bg-surface text-text shadow-sm'
            : 'text-text-muted hover:text-text'}"
            onclick={() => {
              range = value;
            }}
            type="button"
          >
            {text}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="flex flex-1 flex-col p-4">
    {#if history.error}
      <p class="text-text-muted py-8 text-center text-xs">
        Couldn't load the history.
      </p>
    {:else if !history.ready}
      <Skeleton class="h-28 w-full" />
    {:else if points.length === 0}
      <p class="text-text-muted py-8 text-center text-xs">
        Nothing recorded yet : samples are taken every minute.
      </p>
    {:else}
      <svg
        class="min-h-28 w-full flex-1"
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 40"
        aria-label="{title} over the selected range"
      >
        <defs>
          <linearGradient id="usage-fill-{workstationId ?? serviceId ?? 'host'}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.35" />
            <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#usage-fill-{workstationId ?? serviceId ?? 'host'})" />
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div class="text-text-subtle mt-2 flex justify-between text-[0.6875rem]">
        <span>{spanLabel}</span>
        <span>peak {label(peak)}</span>
      </div>
    {/if}
  </div>
</section>
