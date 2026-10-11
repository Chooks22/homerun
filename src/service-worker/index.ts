const sw = self as unknown as ServiceWorkerGlobalScope;

interface ReplacingNotificationOptions extends NotificationOptions {
	renotify: boolean;
}

interface PushMessage {
	body: string;
	tag: string;
	title: string;
	url: string;
}

function readMessage(event: PushEvent): PushMessage {
	const fallback: PushMessage = {
		body: "",
		tag: "homerun",
		title: "Homerun",
		url: "/notifications",
	};
	try {
		return { ...fallback, ...(event.data?.json() as Partial<PushMessage>) };
	} catch {
		return { ...fallback, body: event.data?.text() ?? "" };
	}
}

async function openOrFocus(url: string): Promise<void> {
	const target = new URL(url, sw.location.origin);
	const windows = await sw.clients.matchAll({
		includeUncontrolled: true,
		type: "window",
	});
	const sameOrigin = windows.find(
		(client) => new URL(client.url).origin === target.origin,
	);
	if (sameOrigin) {
		const focused = await sameOrigin.focus();
		await focused.navigate(target.href).catch(() => null);
		return;
	}
	await sw.clients.openWindow(target.href);
}

sw.addEventListener("install", () => {
	void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
	const message = readMessage(event);
	const options: ReplacingNotificationOptions = {
		badge: "/favicon.svg",
		body: message.body,
		data: { url: message.url },
		icon: "/logo.png",
		renotify: true,
		tag: message.tag,
	};
	event.waitUntil(sw.registration.showNotification(message.title, options));
});

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url =
		typeof event.notification.data?.url === "string"
			? event.notification.data.url
			: "/notifications";
	event.waitUntil(openOrFocus(url));
});
