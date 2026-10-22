<script lang="ts">
	import { X } from "@lucide/svelte";
	import type { Snippet } from "svelte";
	import { quintOut } from "svelte/easing";
	import { fade, fly } from "svelte/transition";
	import BrandMark from "#lib/components/brand-mark.svelte";
	import { Button } from "#lib/components/ui/button/index.js";

	let {
		children,
		closeButton = $bindable(null),
		footer,
		onClose,
		open,
	}: {
		children: Snippet;
		closeButton?: HTMLElement | null;
		footer?: Snippet;
		onClose: () => void;
		open: boolean;
	} = $props();

	const CLOSE_AFTER_PX = 100;

	let dragY = $state(0);
	let dragging = $state(false);
	let nav = $state<HTMLElement | null>(null);
	let start: { x: number; y: number } | null = null;
	let vertical: boolean | null = null;

	/** Starts tracking a touch that may become a swipe-down-to-close drag. */
	function onTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		start = { x: touch.clientX, y: touch.clientY };
		vertical = null;
	}

	/** Follows the finger downwards once the gesture reads as a downward pull with the nav scrolled to its top, leaving scrolls of the nav alone. */
	function onTouchMove(event: TouchEvent) {
		if (!start) {
			return;
		}
		const touch = event.touches[0];
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;
		if (vertical === null && Math.abs(dx) + Math.abs(dy) > 8) {
			vertical = dy > Math.abs(dx) && (nav?.scrollTop ?? 0) <= 0;
		}
		if (vertical) {
			dragging = true;
			dragY = Math.max(0, dy);
		}
	}

	/** Closes the sheet when the drag went far enough, otherwise lets it spring back. */
	function onTouchEnd() {
		if (dragY > CLOSE_AFTER_PX) {
			onClose();
		}
		dragging = false;
		dragY = 0;
		start = null;
		vertical = null;
	}
</script>

{#if open}
  <button
    class="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] md:hidden"
    aria-label="Close menu"
    onclick={onClose}
    style:opacity={dragY ? 1 - dragY / 600 : undefined}
    tabindex="-1"
    transition:fade={{ duration: 280 }}
    type="button"
  ></button>

  <div
    class="bg-bg/97 border-border fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-t shadow-2xl backdrop-blur-xl md:hidden"
    aria-label="Navigation"
    aria-modal="true"
    data-slot="mobile-drawer"
    ontouchcancel={onTouchEnd}
    ontouchend={onTouchEnd}
    ontouchmove={onTouchMove}
    ontouchstart={onTouchStart}
    role="dialog"
    style:transform={dragY ? `translateY(${dragY}px)` : undefined}
    style:transition={dragging ? "none" : "transform 220ms ease-out"}
    tabindex="-1"
    transition:fly={{ duration: 380, easing: quintOut, opacity: 1, y: 600 }}
  >
    <div class="bg-border mx-auto mt-2.5 h-1.5 w-12 shrink-0 rounded-full"></div>
    <div class="flex items-center justify-between pr-3 pb-1">
      <BrandMark class="px-4 py-2" />
      <Button aria-label="Close menu" bind:ref={closeButton} onclick={onClose} size="icon" variant="ghost">
        <X class="size-5" />
      </Button>
    </div>
    <nav bind:this={nav} class="flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
      {@render children()}
    </nav>
    {#if footer}
      <div class="border-border border-t pb-[env(safe-area-inset-bottom)]">
        {@render footer()}
      </div>
    {:else}
      <div class="pb-[env(safe-area-inset-bottom)]"></div>
    {/if}
  </div>
{/if}
