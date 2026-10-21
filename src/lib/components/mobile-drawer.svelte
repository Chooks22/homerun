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

	const CLOSE_AFTER_PX = 80;

	let dragX = $state(0);
	let dragging = $state(false);
	let start: { x: number; y: number } | null = null;
	let horizontal: boolean | null = null;

	/** Starts tracking a touch that may become a swipe-to-close drag. */
	function onTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		start = { x: touch.clientX, y: touch.clientY };
		horizontal = null;
	}

	/** Follows the finger leftwards once the gesture reads as horizontal, leaving vertical scrolls of the nav alone. */
	function onTouchMove(event: TouchEvent) {
		if (!start) {
			return;
		}
		const touch = event.touches[0];
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;
		if (horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) {
			horizontal = Math.abs(dx) > Math.abs(dy);
		}
		if (horizontal) {
			dragging = true;
			dragX = Math.min(0, dx);
		}
	}

	/** Closes the drawer when the drag went far enough, otherwise lets it spring back. */
	function onTouchEnd() {
		if (dragX < -CLOSE_AFTER_PX) {
			onClose();
		}
		dragging = false;
		dragX = 0;
		start = null;
		horizontal = null;
	}
</script>

{#if open}
  <button
    class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] md:hidden"
    aria-label="Close menu"
    onclick={onClose}
    style:opacity={dragX ? 1 + dragX / 400 : undefined}
    tabindex="-1"
    transition:fade={{ duration: 280 }}
    type="button"
  ></button>

  <div
    class="panel-strong border-border fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col rounded-r-2xl border-r shadow-2xl md:hidden"
    aria-label="Navigation"
    aria-modal="true"
    data-slot="mobile-drawer"
    ontouchcancel={onTouchEnd}
    ontouchend={onTouchEnd}
    ontouchmove={onTouchMove}
    ontouchstart={onTouchStart}
    role="dialog"
    style:transform={dragX ? `translateX(${dragX}px)` : undefined}
    style:transition={dragging ? "none" : "transform 220ms ease-out"}
    tabindex="-1"
    transition:fly={{ duration: 380, easing: quintOut, opacity: 1, x: -340 }}
  >
    <div class="flex items-center justify-between pt-[max(0.5rem,env(safe-area-inset-top))] pr-3 pb-1">
      <BrandMark class="px-4 py-2.5" />
      <Button aria-label="Close menu" bind:ref={closeButton} onclick={onClose} size="icon" variant="ghost">
        <X class="size-5" />
      </Button>
    </div>
    <nav class="flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
      {@render children()}
    </nav>
    {#if footer}
      <div class="border-border border-t pb-[env(safe-area-inset-bottom)]">
        {@render footer()}
      </div>
    {/if}
  </div>
{/if}
