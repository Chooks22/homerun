import {
	afterEach,
	describe,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	discordPayload,
	messageEmail,
	messageSubject,
	slackPayload,
	telegramPayload,
} = await import("../../../src/lib/services/notification-channel.service");

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

const message = {
	detail: "exit code 1",
	event: "build.failed" as const,
	fields: [
		{ name: "Branch", value: "main" },
		{ name: "Repository", value: `https://example.com/${"a".repeat(60)}.git` },
	],
	link: "https://homerun.example.com/services/svc-1/environments/revisions",
	serviceId: "svc-1",
	serviceName: "api",
	timestamp: "2026-09-16T12:00:00.000Z",
	title: "api failed to build",
};

const { NotificationChannelService } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { NotificationChannelDTO } = await import(
	"../../../src/lib/dto/notification-channel-dto"
);
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { EmailService } = await import(
	"../../../src/lib/services/email.service"
);
const { config } = await import("../../../src/lib/config");
const { JobDTO } = await import("../../../src/lib/dto/job-dto");

type Channel = Parameters<typeof NotificationChannelService.sendTest>[0];
type Message = Parameters<typeof NotificationChannelService.dispatch>[0];

interface FakeChannel {
	enabled: boolean;
	events: string[];
	groupMessages: boolean;
	id: string;
	kind: string;
	name: string;
	target: string;
	updates: Record<string, unknown>[];
	userId: string;
}

function fakeChannel(
	kind: string,
	target: string,
	overrides: Partial<FakeChannel> = {},
): FakeChannel & Channel {
	const channel = {
		enabled: true,
		events: ["build.failed"],
		groupMessages: false,
		id: `ch-${kind}`,
		kind,
		name: `${kind} channel`,
		target,
		updates: [] as Record<string, unknown>[],
		userId: "user-1",
		...overrides,
		update: async (input: Record<string, unknown>) => {
			channel.updates.push(input);
		},
	};
	return channel as unknown as FakeChannel & Channel;
}

interface Posted {
	body: unknown;
	url: string;
}

const realFetch = globalThis.fetch;
const realSmtp = config.smtp;
const realOrigin = config.auth.origin;
const realBaseDomain = config.baseDomain;
const restorers: { mockRestore: () => void }[] = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
	restorers.push(spy);
	return spy;
}

function stubFetch(
	respond: (url: string) => Response | Promise<Response>,
): Posted[] {
	const posted: Posted[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		posted.push({ body: JSON.parse(String(init.body)), url: String(url) });
		return await respond(String(url));
	}) as unknown as typeof fetch;
	return posted;
}

afterEach(() => {
	NotificationChannelService.discardPending();
	setSystemTime();
	globalThis.fetch = realFetch;
	config.smtp = realSmtp;
	config.auth.origin = realOrigin;
	config.baseDomain = realBaseDomain;
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

describe("NotificationChannelService delivery", () => {
	test("dispatch sends each channel kind its own payload and clears lastError", async () => {
		const channels = [
			fakeChannel("discord", "https://discord.com/api/webhooks/1/x"),
			fakeChannel("slack", "https://hooks.slack.com/services/x"),
			fakeChannel("webhook", "https://example.com/hook"),
			fakeChannel("telegram", `${BOT_TOKEN}/-100123`),
		];
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockResolvedValue(
				channels,
			),
		);
		const posted = stubFetch(() => new Response("ok"));

		await NotificationChannelService.dispatch(message);

		const byUrl = new Map(posted.map((p) => [p.url, p.body]));
		expect(byUrl.get("https://discord.com/api/webhooks/1/x")).toEqual(
			discordPayload(message),
		);
		expect(byUrl.get("https://hooks.slack.com/services/x")).toEqual(
			slackPayload(message),
		);
		expect(byUrl.get("https://example.com/hook")).toEqual(message);
		expect(
			byUrl.get(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`),
		).toEqual(telegramPayload("-100123", message));
		for (const channel of channels) {
			expect(channel.updates).toEqual([{ lastError: null }]);
		}
	});

	test("a failed channel records the error and queues a retry without failing the rest", async () => {
		const bad = fakeChannel("webhook", "https://bad.example.com/hook", {
			id: "ch-bad",
		});
		const good = fakeChannel("webhook", "https://good.example.com/hook", {
			id: "ch-good",
		});
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockResolvedValue([
				bad,
				good,
			]),
		);
		const enqueue = track(
			spyOn(QueueService, "enqueue").mockResolvedValue(
				{} as Awaited<ReturnType<typeof QueueService.enqueue>>,
			),
		);
		stubFetch((url) =>
			url.includes("bad")
				? new Response("", { status: 500 })
				: new Response("ok"),
		);

		await NotificationChannelService.dispatch(message);

		expect(bad.updates).toEqual([{ lastError: "Webhook returned HTTP 500" }]);
		expect(good.updates).toEqual([{ lastError: null }]);
		expect(enqueue).toHaveBeenCalledTimes(1);
		const job = enqueue.mock.calls[0][0];
		expect(job.type).toBe("notification_delivery");
		expect(job.payload).toEqual({ channelId: bad.id, message });
	});

	test("a retry that can't even be queued is swallowed", async () => {
		const bad = fakeChannel("webhook", "https://bad.example.com/hook");
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockResolvedValue([bad]),
		);
		track(
			spyOn(QueueService, "enqueue").mockRejectedValue(new Error("db down")),
		);
		stubFetch(() => new Response("", { status: 400 }));

		await NotificationChannelService.dispatch(message);

		expect(bad.updates).toEqual([{ lastError: "Webhook returned HTTP 400" }]);
	});

	test("Telegram failures never leak the bot token", async () => {
		const cases: [() => Response | Promise<Response>, string][] = [
			[
				() => Response.json({ description: "chat not found" }, { status: 400 }),
				"Telegram returned HTTP 400: chat not found",
			],
			[
				() => new Response("not json", { status: 502 }),
				"Telegram returned HTTP 502",
			],
			[
				() => {
					throw new Error(`connect failed ${BOT_TOKEN}`);
				},
				"Telegram couldn't be reached",
			],
			[
				() => {
					throw Object.assign(new Error("slow"), { name: "TimeoutError" });
				},
				"Telegram timed out",
			],
		];
		for (const [respond, expected] of cases) {
			stubFetch(respond);
			const error = (await NotificationChannelService.sendTest(
				fakeChannel("telegram", `${BOT_TOKEN}/42`),
			).catch((err: unknown) => err)) as Error;
			expect(error.message).toBe(expected);
			expect(error.message).not.toContain(BOT_TOKEN);
		}
	});

	test("a Telegram channel without a chat id is refused before any request", async () => {
		const posted = stubFetch(() => new Response("ok"));
		await expect(
			NotificationChannelService.sendTest(fakeChannel("telegram", "no-slash")),
		).rejects.toThrow("The Telegram channel has no bot token and chat id.");
		expect(posted).toHaveLength(0);
	});

	test("sendTest delivers a synthetic failure and clears lastError", async () => {
		const posted = stubFetch(() => new Response("ok"));
		const channel = fakeChannel("webhook", "https://example.com/hook");

		await NotificationChannelService.sendTest(channel);

		const body = posted[0].body as Message;
		expect(body.event).toBe("build.failed");
		expect(body.serviceName).toBe("Test service");
		expect(channel.updates).toEqual([{ lastError: null }]);
	});

	test("email refuses to send without SMTP, and sends through EmailService with it", async () => {
		config.smtp = undefined as unknown as typeof config.smtp;
		await expect(
			NotificationChannelService.sendTest(
				fakeChannel("email", "ops@example.com"),
			),
		).rejects.toThrow("SMTP isn't configured");

		config.smtp = {
			enabled: true,
			from: "homerun@example.com",
			host: "smtp.example.com",
			password: "pw",
			port: 587,
			user: "u",
		};
		const sent: {
			content: string;
			html: string | undefined;
			subject: string;
			to: string;
		}[] = [];
		track(
			spyOn(EmailService.prototype, "send").mockImplementation(async function (
				this: InstanceType<typeof EmailService>,
			) {
				sent.push({
					content: this.content,
					html: this.html,
					subject: this.subject,
					to: this.to,
				});
			} as unknown as () => Promise<never>),
		);
		const channel = fakeChannel("email", "ops@example.com");
		track(
			spyOn(NotificationChannelDTO, "getForDelivery").mockResolvedValue(
				channel,
			),
		);
		expect(
			await NotificationChannelService.retryDelivery(channel.id, message),
		).toEqual({ delivered: true });
		expect(sent).toEqual([
			{
				...messageEmail(message),
				subject: messageSubject(message),
				to: "ops@example.com",
			},
		]);
		expect(sent[0]?.html).toContain(message.title);
		expect(channel.updates).toEqual([{ lastError: null }]);
	});
});

describe("NotificationChannelService.retryDelivery", () => {
	test("skips a channel that's gone, disabled or no longer subscribed", async () => {
		const posted = stubFetch(() => new Response("ok"));
		const lookup = track(spyOn(NotificationChannelDTO, "getForDelivery"));
		lookup.mockResolvedValueOnce(null);
		lookup.mockResolvedValueOnce(
			fakeChannel("webhook", "https://x", { enabled: false }),
		);
		lookup.mockResolvedValueOnce(
			fakeChannel("webhook", "https://x", { events: ["deploy.failed"] }),
		);
		for (let i = 0; i < 3; i++) {
			expect(
				await NotificationChannelService.retryDelivery("gone", message),
			).toEqual({ delivered: false });
		}
		expect(posted).toHaveLength(0);
	});

	test("a failed retry records the error and rethrows so the worker backs off", async () => {
		const channel = fakeChannel("slack", "https://hooks.slack.com/x");
		track(
			spyOn(NotificationChannelDTO, "getForDelivery").mockResolvedValue(
				channel,
			),
		);
		stubFetch(() => new Response("", { status: 404 }));

		await expect(
			NotificationChannelService.retryDelivery(channel.id, message),
		).rejects.toThrow("Webhook returned HTTP 404");
		expect(channel.updates).toEqual([
			{ lastError: "Webhook returned HTTP 404" },
		]);
	});
});

describe("grouped delivery", () => {
	function channelsFor(...channels: (FakeChannel & Channel)[]) {
		track(
			spyOn(NotificationChannelDTO, "listSubscribed").mockImplementation(
				async (event: string) =>
					channels.filter((c) => c.events.includes(event)),
			),
		);
	}

	test("a channel that didn't opt into grouping gets every message as it happens", async () => {
		const grouped = fakeChannel("webhook", "https://grouped.example.com", {
			events: ["build.failed"],
			groupMessages: true,
			id: "ch-grouped",
		});
		const direct = fakeChannel("webhook", "https://direct.example.com", {
			events: ["build.failed"],
			id: "ch-direct",
		});
		channelsFor(grouped, direct);
		const posted = stubFetch(() => new Response("ok"));

		setSystemTime(new Date("2026-09-28T03:00:00Z"));
		await NotificationChannelService.dispatch(message);
		setSystemTime(new Date("2026-09-28T03:00:20Z"));
		await NotificationChannelService.dispatch(message);
		await NotificationChannelService.dispatch(message, { scheduled: true });

		expect(posted.filter((p) => p.url.includes("direct"))).toHaveLength(3);
		expect(posted.filter((p) => p.url.includes("grouped"))).toHaveLength(1);
	});

	test("messages under a minute apart go out as one, each channel getting only its events", async () => {
		const narrow = fakeChannel("webhook", "https://narrow.example.com", {
			events: ["build.failed"],
			groupMessages: true,
			id: "ch-narrow",
		});
		const wide = fakeChannel("webhook", "https://wide.example.com", {
			events: ["build.failed", "update.succeeded"],
			groupMessages: true,
			id: "ch-wide",
		});
		channelsFor(narrow, wide);
		const posted = stubFetch(() => new Response("ok"));
		const updated = {
			...message,
			event: "update.succeeded" as const,
			title: "web was updated",
		};

		setSystemTime(new Date("2026-09-28T03:00:00Z"));
		await NotificationChannelService.dispatch(message);
		expect(posted).toHaveLength(2);

		setSystemTime(new Date("2026-09-28T03:00:20Z"));
		await NotificationChannelService.dispatch(updated);
		await NotificationChannelService.dispatch(message);
		await NotificationChannelService.flushDue();
		expect(posted).toHaveLength(2);

		setSystemTime(new Date("2026-09-28T03:01:21Z"));
		await NotificationChannelService.flushDue();
		const later = posted.slice(2);
		expect(later).toHaveLength(2);
		expect(later.find((p) => p.url.includes("narrow"))?.body).toEqual(message);
		expect(later.find((p) => p.url.includes("wide"))?.body).toMatchObject({
			title: "2 notifications: 1 ok, 1 failed",
		});
	});

	test("a scheduled outcome waits until no scheduled job is still queued or running", async () => {
		const channel = fakeChannel("webhook", "https://hook.example.com", {
			events: ["update.succeeded", "backup.failed"],
			groupMessages: true,
		});
		channelsFor(channel);
		const posted = stubFetch(() => new Response("ok"));
		const active = track(
			spyOn(JobDTO, "hasActiveScheduledWork").mockResolvedValue(true),
		);

		setSystemTime(new Date("2026-09-28T03:00:00Z"));
		await NotificationChannelService.dispatch(
			{ ...message, event: "update.succeeded", title: "web was updated" },
			{ scheduled: true },
		);
		expect(posted).toHaveLength(0);
		setSystemTime(new Date("2026-09-28T03:05:00Z"));
		await NotificationChannelService.dispatch(
			{ ...message, event: "backup.failed", title: "Backup of db failed" },
			{ scheduled: true },
		);
		setSystemTime(new Date("2026-09-28T03:20:00Z"));
		await NotificationChannelService.flushDue();
		expect(posted).toHaveLength(0);

		active.mockResolvedValue(false);
		await NotificationChannelService.flushDue();
		expect(posted).toHaveLength(1);
		expect(posted[0].body).toMatchObject({
			event: "backup.failed",
			title: "Scheduled tasks: 1 ok, 1 failed",
		});
	});
});

describe("fire-and-forget notifications", () => {
	function captureDispatch(): Promise<Message> {
		return new Promise((resolve) => {
			track(
				spyOn(NotificationChannelService, "dispatch").mockImplementation(
					async (msg: Message) => {
						resolve(msg);
					},
				),
			);
		});
	}

	function fakeService(overrides: Record<string, unknown> = {}) {
		const row = {
			buildSource: "image" as const,
			defaultDomainEnabled: true,
			dnsResolvable: true,
			domains: [],
			gitRef: null,
			gitUrl: null,
			id: "svc-1",
			image: "nginx",
			name: "web",
			primaryDomain: null,
			slug: "web",
			stackId: null as string | null,
			tag: "1.27",
			...overrides,
		};
		return {
			id: row.id,
			stackId: row.stackId,
			toJSON: () => row,
		};
	}

	const deployment = {
		toJSON: () => ({
			errorMessage: null,
			finishedAt: new Date("2026-09-16T12:01:05Z"),
			gitCommit: null,
			gitRef: null,
			imageDigest: null,
			log: "",
			startedAt: new Date("2026-09-16T12:00:00Z"),
		}),
	};

	type Notification = Parameters<
		typeof NotificationChannelService.notifyDeploy
	>[0];

	test("a deploy notification links the stack-prefixed public URL", async () => {
		config.baseDomain = "example.com";
		config.auth.origin = "https://homerun.example.com";
		const stackGet = track(
			spyOn(StackDTO, "get").mockResolvedValue({
				name: "Shop",
				slug: "shop",
			} as unknown as Awaited<ReturnType<typeof StackDTO.get>>),
		);
		const dispatched = captureDispatch();

		NotificationChannelService.notifyDeploy({
			dep: deployment,
			ok: true,
			svc: fakeService({ stackId: "stack-1" }),
			trigger: "manual",
		} as unknown as Notification);

		const sent = await dispatched;
		expect(stackGet).toHaveBeenCalledWith("stack-1");
		expect(sent.event).toBe("deploy.succeeded");
		expect(sent.fields).toContainEqual({ name: "Stack", value: "Shop" });
		expect(sent.fields).toContainEqual({
			name: "URL",
			value: "https://shop-web.example.com",
		});
		expect(sent.link).toBe(
			"https://homerun.example.com/services/svc-1/environments/revisions",
		);
	});

	test("a service nobody can resolve gets no URL and no stack lookup", async () => {
		const stackGet = track(spyOn(StackDTO, "get"));
		const dispatched = captureDispatch();

		NotificationChannelService.notifyDeploy({
			dep: deployment,
			ok: true,
			svc: fakeService({ dnsResolvable: false }),
			trigger: "manual",
		} as unknown as Notification);

		const sent = await dispatched;
		expect(stackGet).not.toHaveBeenCalled();
		expect(sent.fields.some((f) => f.name === "URL")).toBe(false);
	});

	test("failures in either fire-and-forget path are logged, never thrown", async () => {
		const listed = new Promise<void>((resolve) => {
			track(
				spyOn(NotificationChannelDTO, "listSubscribed").mockImplementation(
					() => {
						resolve();
						return Promise.reject(new Error("db down"));
					},
				),
			);
		});
		expect(() => NotificationChannelService.notify(message)).not.toThrow();
		await listed;

		const looked = new Promise<void>((resolve) => {
			track(
				spyOn(StackDTO, "get").mockImplementation(() => {
					resolve();
					return Promise.reject("stack gone");
				}),
			);
		});
		expect(() =>
			NotificationChannelService.notifyDeploy({
				dep: deployment,
				ok: false,
				svc: fakeService({ stackId: "s" }),
				trigger: "manual",
			} as unknown as Notification),
		).not.toThrow();
		await looked;
		await Bun.sleep(0);
	});
});
