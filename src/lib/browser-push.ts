import { browserDeviceName } from "#lib/browser-device.js";
import { requestBrowserNotifications } from "#lib/notification-feed.js";
import {
	getPushPublicKey,
	registerBrowserPush,
	unregisterBrowserPush,
} from "#lib/remote/push.remote.js";

const TAB_NOTIFICATIONS_KEY = "homerun:tab-notifications";

/** Whether this browser was turned on for notifications while a Homerun tab is open, because its push service refused to subscribe it, and still has the permission. */
export function tabNotificationsEnabled(): boolean {
	try {
		return (
			localStorage.getItem(TAB_NOTIFICATIONS_KEY) === "on" &&
			typeof Notification !== "undefined" &&
			Notification.permission === "granted"
		);
	} catch {
		return false;
	}
}

function setTabNotifications(enabled: boolean): void {
	try {
		if (enabled) {
			localStorage.setItem(TAB_NOTIFICATIONS_KEY, "on");
		} else {
			localStorage.removeItem(TAB_NOTIFICATIONS_KEY);
		}
	} catch {
		return;
	}
}

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
 * no Homerun tab open. A browser whose push service refuses the subscription
 * (Chromium builds without Google's, like Helium or ungoogled-chromium) gets
 * notifications only while a Homerun tab is open instead, resolving "tab".
 *
 * @throws When the browser can't do push, the permission is refused, the
 *   service worker isn't installed, or the subscription fails otherwise.
 */
export async function enableBrowserPush(): Promise<"push" | "tab"> {
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
	try {
		subscription ??= await registration.pushManager.subscribe({
			applicationServerKey,
			userVisibleOnly: true,
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			setTabNotifications(true);
			return "tab";
		}
		throw err;
	}
	setTabNotifications(false);
	const keys = subscription.toJSON().keys ?? {};
	await registerBrowserPush({
		name: browserDeviceName(navigator.userAgent),
		subscription: {
			endpoint: subscription.endpoint,
			keys: { auth: keys.auth ?? "", p256dh: keys.p256dh ?? "" },
		},
	});
	return "push";
}

/** Turns off notifications while a tab is open, removes this browser's notification channel and drops its push subscription. */
export async function disableBrowserPush(): Promise<void> {
	setTabNotifications(false);
	const subscription = await currentPushSubscription();
	if (!subscription) {
		return;
	}
	await unregisterBrowserPush(subscription.endpoint);
	await subscription.unsubscribe();
}
