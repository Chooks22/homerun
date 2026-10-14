<script lang="ts" module>
	import type { WaterfallInput } from "#lib/tracing/waterfall.js";

	export interface WaterfallSpan extends WaterfallInput {
		attributes: Record<string, unknown>;
		events: {
			attributes: Record<string, unknown>;
			name: string;
			time: string;
		}[];
		kind: number;
		name: string;
		resourceAttributes: Record<string, unknown>;
		serviceName: string;
		statusCode: number;
		statusMessage: string | null;
		traceId: string;
	}
</script>

<script lang="ts">
	import { X } from "@lucide/svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import {
		buildWaterfall,
		formatSpanDuration,
		kindLabel,
		STATUS_ERROR,
		STATUS_OK,
		statusLabel,
	} from "#lib/tracing/waterfall.js";

	interface Props {
		spans: WaterfallSpan[];
	}

	const { spans }: Props = $props();

	const waterfall = $derived(buildWaterfall(spans));
	let selectedId = $state<string | null>(null);
	const selected = $derived(
		spans.find((span) => span.spanId === selectedId) ?? null,
	);
	const ticks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((share) => ({
			label: formatSpanDuration(waterfall.totalMs * share),
			share,
		})),
	);

	function barTone(code: number): string {
		if (code === STATUS_ERROR) {
			return "bg-red-500";
		}
		return code === STATUS_OK ? "bg-green-500" : "bg-accent";
	}

	function shown(value: unknown): string {
		return typeof value === "object" && value !== null
			? JSON.stringify(value)
			: String(value);
	}

	function sinceStart(time: Date | string): string {
		return `+${formatSpanDuration(new Date(time).getTime() - waterfall.startMs)}`;
	}
</script>

{#snippet keyValues(entries: Record<string, unknown>)}
  <dl class="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
    {#each Object.entries(entries) as [key, value] (key)}
      <dt class="text-text-subtle font-mono break-all">{key}</dt>
      <dd class="text-text font-mono break-all">{shown(value)}</dd>
    {/each}
  </dl>
{/snippet}

<div class="space-y-4">
  <section class="panel overflow-x-auto rounded-md">
    <div class="min-w-160">
    <div class="border-border text-text-subtle grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 border-b px-4 py-2 text-xs">
      <span>Span</span>
      <span class="relative mr-16 h-4">
        {#each ticks as tick (tick.share)}
          <span
            class="absolute top-0 font-mono whitespace-nowrap"
            style:left="{tick.share * 100}%"
            style:transform="translateX(-{tick.share * 100}%)"
          >
            {tick.label}
          </span>
        {/each}
      </span>
    </div>
    <ol>
      {#each waterfall.rows as row (row.span.spanId)}
        <li class="border-border/60 border-b last:border-0">
          <button
            class="hover:bg-surface-2 grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-4 py-2 text-left {selectedId ===
            row.span.spanId
              ? 'bg-surface-2'
              : ''}"
            aria-pressed={selectedId === row.span.spanId}
            onclick={() =>
              selectedId = selectedId === row.span.spanId ? null : row.span.spanId}
            type="button"
          >
            <span class="flex min-w-0 items-center gap-2" style:padding-left="{row.depth * 0.875}rem">
              <span class="size-2 shrink-0 rounded-full {barTone(row.span.statusCode)}"></span>
              <span class="text-text truncate text-sm">{row.span.name || "(unnamed span)"}</span>
              <span class="text-text-subtle hidden truncate text-xs lg:inline">{row.span.serviceName}</span>
            </span>
            <span class="relative mr-16 h-5">
              <span
                class="absolute top-1 h-3 rounded-sm {barTone(row.span.statusCode)}"
                style:left="{Math.min(row.offsetPercent, 99.5)}%"
                style:width="max({row.widthPercent}%, 2px)"
              ></span>
              <span
                class="text-text-muted absolute top-0 font-mono text-[0.6875rem] whitespace-nowrap"
                style:left="calc({Math.min(row.offsetPercent + row.widthPercent, 100)}% + 0.375rem)"
              >
                {formatSpanDuration(row.span.durationMs)}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ol>
    </div>
  </section>

  {#if selected}
    <section class="panel rounded-md">
      <div class="border-border flex items-start justify-between gap-3 border-b px-4 py-3">
        <div class="min-w-0">
          <h3 class="text-text truncate text-sm font-medium">{selected.name || "(unnamed span)"}</h3>
          <p class="text-text-subtle font-mono text-xs break-all">
            {selected.serviceName} · span {selected.spanId}
          </p>
        </div>
        <Button
          aria-label="Close span details"
          onclick={() => selectedId = null}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X class="size-4" />
        </Button>
      </div>
      <div class="space-y-4 p-4">
        <dl class="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
          <div>
            <dt class="text-text-subtle">Duration</dt>
            <dd class="text-text font-mono">{formatSpanDuration(selected.durationMs)}</dd>
          </div>
          <div>
            <dt class="text-text-subtle">Started</dt>
            <dd class="text-text font-mono">{sinceStart(selected.startTime)}</dd>
          </div>
          <div>
            <dt class="text-text-subtle">Kind</dt>
            <dd class="text-text">{kindLabel(selected.kind)}</dd>
          </div>
          <div>
            <dt class="text-text-subtle">Status</dt>
            <dd class={selected.statusCode === STATUS_ERROR ? "text-red-500" : "text-text"}>
              {statusLabel(selected.statusCode)}{selected.statusMessage ? `: ${selected.statusMessage}` : ""}
            </dd>
          </div>
        </dl>

        {#if Object.keys(selected.attributes).length > 0}
          <div>
            <h4 class="eyebrow mb-1.5">Attributes</h4>
            {@render keyValues(selected.attributes)}
          </div>
        {/if}

        {#if selected.events.length > 0}
          <div>
            <h4 class="eyebrow mb-1.5">Events ({selected.events.length})</h4>
            <ol class="border-border bg-surface-2 max-h-96 overflow-y-auto rounded-md border p-2 font-mono text-xs">
              {#each selected.events as event, eventIndex (eventIndex)}
                <li class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 py-0.5">
                  <span class="text-text-subtle text-right">{event.time ? sinceStart(event.time) : ""}</span>
                  <span class="text-text wrap-break-word whitespace-pre-wrap">{event.name}</span>
                  {#if Object.keys(event.attributes).length > 0}
                    <div class="col-start-2 mt-1 mb-1">{@render keyValues(event.attributes)}</div>
                  {/if}
                </li>
              {/each}
            </ol>
          </div>
        {/if}

        {#if Object.keys(selected.resourceAttributes).length > 0}
          <details>
            <summary class="text-text cursor-pointer text-xs font-medium">Resource</summary>
            <div class="mt-1.5">{@render keyValues(selected.resourceAttributes)}</div>
          </details>
        {/if}
      </div>
    </section>
  {:else}
    <p class="text-text-subtle text-xs">Pick a span to see its attributes and events.</p>
  {/if}
</div>
