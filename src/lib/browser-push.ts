import { browserDeviceName } from "#lib/browser-device.js";
import { requestBrowserNotifications } from "#lib/notification-feed.js";
import {
	getPushPublicKey,
	registerBrowserPush,
	unregisterBrowserPush,
} from "#lib/remote/push.remote.js";

/** Whether this browser can receive Web Push through a service worker. */
export function browserPushSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined" &&
		"PushManager" in window &&
		typeof Notification !== "undefined"
	);
}

function urlBase64ToBytes(text: string): Uint8Array<ArrayBuffer> {
	const padded = `${text}${"=".repeat((4 - (text.length % 4)) % 4)}`
		.replaceAll("-", "+")
		.replaceAll("_", "/");
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** This browser's current push subscription, or null when it has none or can't have one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
	if (!browserPushSupported()) {
		return null;
	}
	const registration = await navigator.serviceWorker.getRegistration();
	return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks for notification permission, subscribes this browser to Web Push with
 * the instance's key (replacing a subscription made with an older key) and
 * saves it as a browser notification channel, so notifications arrive with
 * no Homerun tab open.
 *
 * @throws When the browser can't do push, the permission is refused, the
 *   service worker isn't installed, or the push service refuses.
 */
export async function enableBrowserPush(): Promise<void> {
	if (!browserPushSupported()) {
		throw new Error("This browser can't receive push notifications.");
	}
	await requestBrowserNotifications();
	if (!(await navigator.serviceWorker.getRegistration())) {
		throw new Error(
			"The notification worker isn't installed yet. Reload the page and try again.",
		);
	}
	const registration = await navigator.serviceWorker.ready;
	const applicationServerKey = urlBase64ToBytes(await getPushPublicKey());
	let subscription = await registration.pushManager.getSubscription();
	const currentKey = subscription?.options.applicationServerKey;
	if (
		subscription &&
		currentKey &&
		new Uint8Array(currentKey).join() !== applicationServerKey.join()
	) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({
		applicationServerKey,
		userVisibleOnly: true,
	});
	const keys = subscription.toJSON().keys ?? {};
	await registerBrowserPush({
		name: browserDeviceName(navigator.userAgent),
		subscription: {
			endpoint: subscription.endpoint,
			keys: { auth: keys.auth ?? "", p256dh: keys.p256dh ?? "" },
		},
	});
}

/** Removes this browser's notification channel and drops its push subscription. */
export async function disableBrowserPush(): Promise<void> {
	const subscription = await currentPushSubscription();
	if (!subscription) {
		return;
	}
	await unregisterBrowserPush(subscription.endpoint);
	await subscription.unsubscribe();
}
