<script lang="ts">
	import { BellOff, BellRing } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";
	import {
		browserPushSupported,
		currentPushSubscription,
		disableBrowserPush,
		enableBrowserPush,
		tabNotificationsEnabled,
	} from "#lib/browser-push.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { browserNotificationPermission } from "#lib/notification-feed.js";
	import { toastError } from "#lib/toast.js";

	interface Props {
		onchange?: () => void;
		showDisable?: boolean;
	}

	const { onchange, showDisable = false }: Props = $props();

	let supported = $state(false);
	let subscribed = $state(false);
	let denied = $state(false);
	let busy = $state(false);

	async function refreshState() {
		supported = browserPushSupported();
		denied = browserNotificationPermission() === "denied";
		subscribed =
			tabNotificationsEnabled() ||
			(await currentPushSubscription().catch(() => null)) !== null;
	}

	onMount(() => {
		void refreshState();
	});

	async function enableCallback() {
		busy = true;
		try {
			const mode = await enableBrowserPush();
			onchange?.();
			return mode;
		} finally {
			busy = false;
			await refreshState();
		}
	}

	function handleEnable() {
		return toast.promise(enableCallback(), {
			error: (error) =>
				toastError(error, "Couldn't turn on browser notifications."),
			loading: "Waiting for the browser",
			success: (mode) =>
				mode === "push"
					? "Browser notifications are on, even with Homerun closed."
					: "This browser has no push service, so notifications show only while a Homerun tab is open.",
		});
	}

	async function disableCallback() {
		busy = true;
		try {
			await disableBrowserPush();
			onchange?.();
		} finally {
			busy = false;
			await refreshState();
		}
	}

	function handleDisable() {
		return toast.promise(disableCallback(), {
			error: (error) =>
				toastError(error, "Couldn't turn off browser notifications."),
			loading: "Turning off browser notifications",
			success: "This browser no longer gets notifications.",
		});
	}
</script>

{#if supported && !denied && !subscribed}
  <Button disabled={busy} onclick={handleEnable} size="sm" variant="outline">
    <BellRing class="size-3.5" />
    Turn on browser notifications
  </Button>
{:else if supported && subscribed && showDisable}
  <Button disabled={busy} onclick={handleDisable} size="sm" variant="outline">
    <BellOff class="size-3.5" />
    Turn off on this browser
  </Button>
{/if}
