import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { PushSubscriptionGoneError, sendWebPush, toBase64Url } = await import(
	"../../../src/lib/server/web-push"
);
const { WebPushService } = await import(
	"../../../src/lib/services/web-push.service"
);
const { NotificationChannelService } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { NotificationChannelDTO } = await import(
	"../../../src/lib/dto/notification-channel-dto"
);
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { config } = await import("../../../src/lib/config");

type Channel = Parameters<typeof NotificationChannelService.sendTest>[0];
type Message = Parameters<typeof NotificationChannelService.dispatch>[0];
type Settings = Awaited<ReturnType<typeof InstanceSettingsDTO.get>>;
type StartedNotification = Parameters<
	typeof NotificationChannelService.notifyDeployStarted
>[0];

const realFetch = globalThis.fetch;
const realSmtp = config.smtp;
const restorers: { mockRestore: () => void }[] = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
	restorers.push(spy);
	return spy;
}

afterEach(() => {
	NotificationChannelService.discardPending();
	globalThis.fetch = realFetch;
	config.smtp = realSmtp;
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

async function subscription(endpoint = "https://push.example.com/send/abc") {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const raw = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	return {
		endpoint,
		keys: {
			auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
			p256dh: toBase64Url(raw),
		},
	};
}

interface Sent {
	headers: Headers;
	url: string;
}

function stubFetch(respond: () => Response | Promise<Response>): Sent[] {
	const sent: Sent[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ headers: new Headers(init.headers), url: String(url) });
		return await respond();
	}) as unknown as typeof fetch;
	return sent;
}

const payload = {
	body: "Branch: main",
	tag: "svc-1:build",
	title: "api is building",
	url: "/services/svc-1",
};

describe("sendWebPush", () => {
	test("posts an encrypted aes128gcm body with a VAPID header", async () => {
		const { generateVapidKeys } = await import(
			"../../../src/lib/server/web-push"
		);
		const keys = await generateVapidKeys();
		const sent = stubFetch(() => new Response(null, { status: 201 }));
		await sendWebPush(await subscription(), payload, keys, "mailto:a@b.c");
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe("https://push.example.com/send/abc");
		expect(sent[0].headers.get("content-encoding")).toBe("aes128gcm");
		expect(sent[0].headers.get("authorization")).toStartWith("vapid t=");
		expect(sent[0].headers.get("ttl")).toBe("86400");
	});

	test("a 404 or 410 means the subscription is gone, anything else is an error", async () => {
		const { generateVapidKeys } = await import(
			"../../../src/lib/server/web-push"
		);
		const keys = await generateVapidKeys();
		const sub = await subscription();
		stubFetch(() => new Response(null, { status: 410 }));
		expect(sendWebPush(sub, payload, keys, "mailto:a@b.c")).rejects.toThrow(
			PushSubscriptionGoneError,
		);
		stubFetch(() => new Response("bad jwt", { status: 403 }));
		expect(sendWebPush(sub, payload, keys, "mailto:a@b.c")).rejects.toThrow(
			"The push service returned HTTP 403: bad jwt",
		);
		globalThis.fetch = (async () => {
			throw Object.assign(new Error("slow"), { name: "TimeoutError" });
		}) as unknown as typeof fetch;
		expect(sendWebPush(sub, payload, keys, "mailto:a@b.c")).rejects.toThrow(
			"The push service timed out.",
		);
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(sendWebPush(sub, payload, keys, "mailto:a@b.c")).rejects.toThrow(
			"The push service couldn't be reached.",
		);
	});
});

describe("WebPushService", () => {
	test("a failed settings read isn't cached, an undecryptable key is replaced", async () => {
		track(
			spyOn(InstanceSettingsDTO, "get").mockRejectedValue(new Error("db down")),
		);
		expect(WebPushService.publicKey()).rejects.toThrow("db down");
		restorers.splice(0).forEach((spy) => {
			spy.mockRestore();
		});

		const persisted: Record<string, unknown>[] = [];
		const settings = {
			persistVapid: async (input: Record<string, unknown>) => {
				persisted.push(input);
			},
			toJSON: () => ({
				vapidPrivateKeyEnc: "not-decryptable",
				vapidPublicKey: "stale",
			}),
		};
		track(
			spyOn(InstanceSettingsDTO, "get").mockResolvedValue(
				settings as unknown as Settings,
			),
		);
		const publicKey = await WebPushService.publicKey();
		expect(publicKey).not.toBe("stale");
		expect(persisted).toHaveLength(1);
		expect(persisted[0].vapidPublicKey).toBe(publicKey);
		expect(persisted[0].vapidPrivateKeyEnc).not.toContain(
			(await WebPushService.keys()).privateKey,
		);
	});

	test("signs as the SMTP sender when there is one", async () => {
		config.smtp = { ...realSmtp, from: "Homerun <ops@example.com>" };
		const sent = stubFetch(() => new Response(null, { status: 201 }));
		await WebPushService.send(await subscription(), payload);
		const token =
			sent[0].headers.get("authorization")?.match(/t=([^,]+)/)?.[1] ?? "";
		const claims = JSON.parse(
			Buffer.from(token.split(".")[1], "base64url").toString(),
		);
		expect(claims.sub).toBe("mailto:ops@example.com");
	});
});

function browserChannel(target: string) {
	const channel = {
		enabled: true,
		events: ["build.started"],
		id: "ch-browser",
		kind: "browser",
		name: "Firefox on Linux",
		target,
		updates: [] as Record<string, unknown>[],
		userId: "user-1",
		update: async (input: Record<string, unknown>) => {
			channel.updates.push(input);
		},
	};
	return channel;
}

const message: Message = {
	detail: null,
	event: "build.started",
	fields: [{ name: "Branch", value: "main" }],
	link: null,
	serviceId: "svc-1",
	serviceName: "api",
	timestamp: "2026-01-01T00:00:00.000Z",
	title: "api is building",
};

describe("browser channel delivery", () => {
	test("pushes to the stored subscription and clears lastError", async () => {
		const channel = browserChannel(JSON.stringify(await subscription()));
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockResolvedValue([
				channel as unknown as Channel,
			]),
		);
		const sent = stubFetch(() => new Response(null, { status: 201 }));
		await NotificationChannelService.dispatch(message);
		expect(sent.map((s) => s.url)).toEqual([
			"https://push.example.com/send/abc",
		]);
		expect(channel.updates).toEqual([{ lastError: null }]);
	});

	test("an expired subscription disables the channel without queuing a retry", async () => {
		const channel = browserChannel(JSON.stringify(await subscription()));
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockResolvedValue([
				channel as unknown as Channel,
			]),
		);
		const enqueue = track(spyOn(QueueService, "enqueue"));
		stubFetch(() => new Response(null, { status: 404 }));
		await NotificationChannelService.dispatch(message);
		expect(channel.updates[0]).toEqual({ enabled: false });
		expect(String(channel.updates[1].lastError)).toContain("expired");
		expect(enqueue).not.toHaveBeenCalled();
	});

	test("a target that isn't a subscription fails the test send", async () => {
		const channel = browserChannel("{nope");
		expect(
			NotificationChannelService.sendTest(channel as unknown as Channel),
		).rejects.toThrow("The browser channel has no push subscription.");
	});
});

describe("notifyDeployStarted", () => {
	const svc = {
		id: "svc-1",
		stackId: "stack-1",
		toJSON: () => ({
			buildSource: "git",
			gitRef: "main",
			gitUrl: "https://github.com/example/app.git",
			id: "svc-1",
			image: "",
			name: "api",
			tag: "latest",
		}),
	};
	const dep = {
		rollbackOfDeploymentId: null,
		toJSON: () => ({
			errorMessage: null,
			finishedAt: null,
			gitCommit: null,
			gitRef: "main",
			imageDigest: null,
			log: null,
			startedAt: new Date(),
		}),
	};

	test("dispatches build.started for a git build, nothing for a scheduled run", async () => {
		track(
			spyOn(StackDTO, "get").mockResolvedValue({
				name: "Shop",
			} as unknown as Awaited<ReturnType<typeof StackDTO.get>>),
		);
		const dispatched = new Promise<Message>((resolve) => {
			track(
				spyOn(NotificationChannelService, "dispatch").mockImplementation(
					async (msg: Message) => {
						resolve(msg);
					},
				),
			);
		});
		NotificationChannelService.notifyDeployStarted({
			dep,
			svc,
			trigger: "cron",
		} as unknown as StartedNotification);
		NotificationChannelService.notifyDeployStarted({
			dep,
			svc,
			trigger: "push",
		} as unknown as StartedNotification);
		const sent = await dispatched;
		expect(sent.event).toBe("build.started");
		expect(sent.title).toBe("api is building");
		expect(sent.fields[0]).toEqual({ name: "Stack", value: "Shop" });
	});

	test("a failed lookup is logged, never thrown", async () => {
		const looked = new Promise<void>((resolve) => {
			track(
				spyOn(StackDTO, "get").mockImplementation(() => {
					resolve();
					return Promise.reject(new Error("db down"));
				}),
			);
		});
		expect(() =>
			NotificationChannelService.notifyDeployStarted({
				dep,
				svc,
				trigger: "manual",
			} as unknown as StartedNotification),
		).not.toThrow();
		await looked;
	});
});
