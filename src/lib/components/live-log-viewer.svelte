<script lang="ts">
	import { Loader2, RefreshCw, Terminal } from "@lucide/svelte";
	import { onDestroy, tick } from "svelte";
	import AnsiLine from "#lib/components/ansi-line.svelte";
	import { resolve } from "$app/paths";

	// Extracted from the Logs tab (services/[serviceId]/logs/+page.svelte) so
	// the same live-streamed, ANSI-colored log panel can also be embedded
	// directly in the Overview tab : same "shared chrome" precedent as
	// form-styles.ts, just for a whole panel instead of class strings.
	const {
		serviceId,
		workloadId,
		heightClass = "h-[28rem]",
		logsUrl,
	}: {
		serviceId: string;
		/** The container or swarm service to stream from, null when there's nothing deployed : see $lib/service-state.ts. Never gated on health, a failed workload's logs are exactly what's wanted. */
		workloadId: string | null;
		heightClass?: string;
		/** Overrides the per-service stream, for a container that isn't one (see System Logs). */
		logsUrl?: string;
	} = $props();

	let lines = $state<string[]>([]);
	let connected = $state(false);
	let errored = $state(false);
	let errorMessage = $state("");
	let logEl = $state<HTMLElement | undefined>();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let cancelled = false;

	/**
	 * Opens the container's log stream and appends complete lines as they arrive,
	 * keeping the panel scrolled to the bottom. Sets `errored` when the request
	 * fails or the stream breaks, unless the stream was cancelled deliberately.
	 */
	async function connect() {
		if (!workloadId) {
			return;
		}
		lines = [];
		connected = false;
		errored = false;
		errorMessage = "";

		try {
			const res = await fetch(
				logsUrl ??
					resolve("/(protected)/services/[serviceId]/logs", { serviceId }),
			);
			if (!(res.ok && res.body)) {
				errorMessage = res.ok ? "" : (await res.text()).trim();
				errored = true;
				return;
			}
			connected = true;

			const decoder = new TextDecoder();
			reader = res.body.getReader();
			let buffer = "";

			while (!cancelled) {
				// oxlint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				if (parts.length > 0) {
					lines.push(...parts);
					// oxlint-disable-next-line no-await-in-loop -- each chunk renders before the next is read
					await tick();
					logEl?.scrollTo({ top: logEl.scrollHeight });
				}
			}
		} catch {
			if (!cancelled) {
				errored = true;
			}
		} finally {
			connected = false;
		}
	}

	// Reconnects whenever the service (or its workload) changes, not just on
	// mount. Navigating between two services keeps this component instance
	// alive — SvelteKit reuses it across the same route — so a mount-only
	// connect left the previous container's stream running under the new
	// service's page, which is what "clicking a linked service doesn't refresh
	// the logs" was.
	$effect(() => {
		const target = `${serviceId}:${workloadId ?? ""}`;
		void target;
		cancelled = true;
		reader?.cancel();
		reader = undefined;
		cancelled = false;
		void connect();

		return () => {
			cancelled = true;
			reader?.cancel();
		};
	});

	onDestroy(() => {
		cancelled = true;
		reader?.cancel();
	});

	function reconnect() {
		cancelled = false;
		void connect();
	}
</script>

<section class="panel rounded-md">
  <div class="border-border flex items-center justify-between gap-3 border-b px-5 py-4">
    <div class="flex items-center gap-2">
      <Terminal class="text-text-muted size-4" />
      <h2 class="eyebrow">Logs</h2>
      {#if connected}
        <span class="flex items-center gap-1 text-xs text-green-600">
          <span class="size-1.5 rounded-full bg-green-500"></span>
          live
        </span>
      {/if}
    </div>
    <button
      class="text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!workloadId}
      onclick={reconnect}
      type="button"
    >
      <RefreshCw class="size-3.5" />
      Reconnect
    </button>
  </div>

  <div
    class="{heightClass} overflow-y-auto log-output"
    bind:this={logEl}
  >
    {#if !workloadId}
      <p class="text-zinc-500">This service hasn't been deployed yet.</p>
    {:else if errored}
      <p class="text-red-400">
        Couldn't connect to the log stream{errorMessage ? `: ${errorMessage}` : ". Try Reconnect."}
      </p>
    {:else if lines.length === 0}
      <p class="flex items-center gap-2 text-zinc-500">
        <Loader2 class="size-3.5 animate-spin" />
        Waiting for output…
      </p>
    {:else}
      {#each lines as line, i (i)}
        <AnsiLine {line} />
      {/each}
    {/if}
  </div>
</section>
