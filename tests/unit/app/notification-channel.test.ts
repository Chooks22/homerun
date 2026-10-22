import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	deliveryRetryJob,
	discordPayload,
	messageBody,
	messageSubject,
	slackPayload,
	telegramPayload,
} = await import("../../../src/lib/services/notification-channel.service");
const {
	channelTargetLabel,
	formatTelegramTarget,
	parseTelegramTarget,
	pushEndpoint,
	pushEndpointDigest,
} = await import("../../../src/lib/notification-channel-target");
const { notificationDeliveryJobPayload } = await import(
	"../../../src/lib/services/queue/payloads"
);
const { deployEvent, deployTitle, isFailureEvent } = await import(
	"../../../src/lib/notification-events"
);
const {
	deployMessage,
	formatDuration,
	ipBanMessage,
	logTail,
	revisionHealthMessage,
	statusChecksMessage,
	uptimeMessage,
	withStackTitle,
} = await import("../../../src/lib/services/notification-messages");
const { channelTargetFromForm, validateChannelTarget } = await import(
	"../../../src/lib/server/validation/notification-channel"
);

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

describe("deployEvent", () => {
	test("a git service reports builds whatever triggered it", () => {
		expect(deployEvent("git", "manual", false)).toBe("build.failed");
		expect(deployEvent("git", "cron", true)).toBe("build.succeeded");
	});

	test("a promote to a git service is a deploy, nothing was built", () => {
		expect(deployEvent("git", "promote", true)).toBe("deploy.succeeded");
		expect(deployEvent("git", "promote", false)).toBe("deploy.failed");
	});

	test("a scheduled image redeploy is an update", () => {
		expect(deployEvent("image", "cron", false)).toBe("update.failed");
		expect(deployEvent("image", "cron", true)).toBe("update.succeeded");
	});

	test("a manual image deploy is a deploy", () => {
		expect(deployEvent("image", "manual", false)).toBe("deploy.failed");
	});

	test("the title reads as a sentence", () => {
		expect(deployTitle("update.failed", "api")).toBe("api failed to update");
	});
});

describe("channel formatting", () => {
	test("email subject and body carry the title and the detail", () => {
		expect(messageSubject(message)).toBe("[Homerun] api failed to build");
		expect(messageBody(message)).toContain("Event: Build failed");
		expect(messageBody(message)).toContain("exit code 1");
		expect(messageBody(message)).toContain("Branch: main");
		expect(messageBody(message)).toContain(
			"Open: https://homerun.example.com/services/svc-1/environments/revisions",
		);
		expect(messageBody({ ...message, detail: null })).not.toContain(
			"exit code 1",
		);
	});

	test("a Discord failure is a red embed, a success a green one", () => {
		const [failed] = discordPayload(message).embeds;
		expect(failed?.title).toBe("api failed to build");
		expect(failed?.color).toBe(0xef_44_44);
		expect(failed?.description).toContain("exit code 1");
		expect(failed?.url).toBe(message.link);
		expect(failed?.fields).toContainEqual({
			inline: true,
			name: "Branch",
			value: "main",
		});
		expect(
			failed?.fields.find((field) => field.name === "Repository")?.inline,
		).toBe(false);

		const [recovered] = discordPayload({
			...message,
			detail: null,
			event: "service.up",
		}).embeds;
		expect(recovered?.color).toBe(0x10_b9_81);
		expect(recovered?.description).toBeUndefined();
	});

	test("a huge Discord detail keeps its end, where the error is", () => {
		const [embed] = discordPayload({
			...message,
			detail: `${"x".repeat(10_000)}the real error`,
		}).embeds;
		expect(embed?.description?.length).toBeLessThan(4100);
		expect(embed?.description).toContain("the real error");
	});
});

describe("Slack and Telegram formatting", () => {
	test("a Slack failure is a red attachment linking to Homerun", () => {
		const payload = slackPayload(message);
		const [attachment] = payload.attachments;
		expect(payload.text).toBe("api failed to build");
		expect(attachment?.color).toBe("#ef4444");
		expect(attachment?.title_link).toBe(message.link);
		expect(attachment?.text).toContain("exit code 1");
		expect(attachment?.fields).toContainEqual({
			short: true,
			title: "Branch",
			value: "main",
		});
		expect(attachment?.ts).toBe(1_789_560_000);
		expect(
			slackPayload({ ...message, detail: null, event: "service.up" })
				.attachments[0]?.color,
		).toBe("#10b981");
	});

	test("a Telegram message is escaped HTML for the chat", () => {
		const payload = telegramPayload("-100123", {
			...message,
			detail: "<script>boom</script>",
			serviceName: "a & b",
		});
		expect(payload.chat_id).toBe("-100123");
		expect(payload.parse_mode).toBe("HTML");
		expect(payload.text).toStartWith("<b>api failed to build</b>");
		expect(payload.text).toContain("a &amp; b");
		expect(payload.text).toContain(
			"<pre>&lt;script&gt;boom&lt;/script&gt;</pre>",
		);
		expect(payload.text).toContain(`<a href="${message.link}">`);
	});

	test("a huge Telegram message stays under Telegram's limit", () => {
		const payload = telegramPayload("-100123", {
			...message,
			fields: Array.from({ length: 200 }, (_, index) => ({
				name: `Field ${index}`,
				value: "x".repeat(40),
			})),
		});
		expect(payload.text.length).toBeLessThanOrEqual(4096);
	});

	test("the Telegram target packs the token and chat, and never shows the token", () => {
		const target = formatTelegramTarget({
			botToken: ` ${BOT_TOKEN} `,
			chatId: "-100123",
		});
		expect(parseTelegramTarget(target)).toEqual({
			botToken: BOT_TOKEN,
			chatId: "-100123",
		});
		expect(parseTelegramTarget("no-separator")).toBeNull();
		expect(channelTargetLabel("telegram", target)).toBe("Chat -100123");
		expect(channelTargetLabel("slack", "https://hooks.slack.com/x")).toBe(
			"https://hooks.slack.com/x",
		);

		const form = new FormData();
		form.set("kind", "telegram");
		form.set("telegramBotToken", BOT_TOKEN);
		form.set("telegramChatId", "@homerun_alerts");
		form.set("target", "ignored");
		expect(channelTargetFromForm(form)).toBe(`${BOT_TOKEN}/@homerun_alerts`);
		form.set("kind", "slack");
		expect(channelTargetFromForm(form)).toBe("ignored");

		const edit = new FormData();
		edit.set("kind", "slack");
		edit.set("telegramBotToken", "");
		edit.set("telegramChatId", "-100999");
		const current = { kind: "telegram" as const, target };
		expect(channelTargetFromForm(edit, current)).toBe(`${BOT_TOKEN}/-100999`);
		edit.set("telegramBotToken", "987:new");
		expect(channelTargetFromForm(edit, current)).toBe("987:new/-100999");
	});
});

describe("delivery retries", () => {
	test("a failed delivery becomes a delayed, retried job on the channel's owner", () => {
		const now = new Date("2026-09-16T12:00:00.000Z");
		const job = deliveryRetryJob(
			{ id: "chan-1", name: "On-call", userId: "user-1" },
			message,
			now,
		);
		expect(job.type).toBe("notification_delivery");
		expect(job.userId).toBe("user-1");
		expect(job.maxAttempts).toBeGreaterThan(1);
		expect(job.runAt?.getTime()).toBeGreaterThan(now.getTime());
		expect(job.title).toBe('Deliver "api failed to build" to On-call');
		expect(notificationDeliveryJobPayload.parse(job.payload)).toEqual({
			channelId: "chan-1",
			message,
		});
	});

	test("a payload with an unknown event is rejected", () => {
		expect(
			notificationDeliveryJobPayload.safeParse({
				channelId: "chan-1",
				message: { ...message, event: "nope" },
			}).success,
		).toBe(false);
	});
});

describe("validateChannelTarget", () => {
	test("a Discord channel needs a Discord webhook URL", () => {
		expect(
			validateChannelTarget(
				"discord",
				"https://discord.com/api/webhooks/1/abc",
			),
		).toBeNull();
		expect(
			validateChannelTarget("discord", "https://example.com/hook"),
		).not.toBeNull();
	});

	test("a Slack channel needs a Slack incoming webhook URL", () => {
		expect(
			validateChannelTarget(
				"slack",
				"https://hooks.slack.com/services/T000/B000/XXXX",
			),
		).toBeNull();
		expect(
			validateChannelTarget("slack", "https://example.com/services/T000"),
		).not.toBeNull();
		expect(
			validateChannelTarget("slack", "http://hooks.slack.com/services/T000"),
		).not.toBeNull();
	});

	test("a Telegram channel needs a bot token and a chat id", () => {
		expect(
			validateChannelTarget("telegram", `${BOT_TOKEN}/-1001234567890`),
		).toBeNull();
		expect(
			validateChannelTarget("telegram", `${BOT_TOKEN}/@homerun_alerts`),
		).toBeNull();
		expect(validateChannelTarget("telegram", "not-a-token/123")).toContain(
			"bot token",
		);
		expect(validateChannelTarget("telegram", `${BOT_TOKEN}/chat`)).toContain(
			"chat id",
		);
		expect(validateChannelTarget("telegram", "")).not.toBeNull();
	});

	test("a generic webhook needs http(s), an email needs an address", () => {
		expect(validateChannelTarget("webhook", "https://example.com")).toBeNull();
		expect(
			validateChannelTarget("webhook", "ftp://example.com"),
		).not.toBeNull();
		expect(validateChannelTarget("webhook", "not-a-url")).toBe(
			"That doesn't look like a URL.",
		);
		expect(validateChannelTarget("email", "a@example.com")).toBeNull();
		expect(validateChannelTarget("email", "nope")).not.toBeNull();
	});
});

describe("deploy and uptime messages", () => {
	const service = {
		buildSource: "image" as const,
		gitRef: null,
		gitUrl: null,
		id: "svc-1",
		image: "nginx",
		name: "web",
		tag: "1.27",
	};
	const deployment = {
		errorMessage: null,
		finishedAt: new Date("2026-09-16T12:01:05Z"),
		gitCommit: null,
		gitRef: null,
		imageDigest: "sha256:0123456789abcdef0123456789abcdef",
		log: "",
		startedAt: new Date("2026-09-16T12:00:00Z"),
	};

	test("a successful scheduled update lists the image, digest, duration and URL", () => {
		const built = deployMessage(
			{
				deployment,
				origin: "https://homerun.example.com/",
				stackName: "Blog",
				publicUrl: "https://web.example.com",
				service,
				trigger: "cron",
			},
			true,
			"2026-09-16T12:01:05Z",
		);
		expect(built.event).toBe("update.succeeded");
		expect(built.title).toBe("web was updated");
		expect(built.detail).toBeNull();
		expect(built.link).toBe(
			"https://homerun.example.com/services/svc-1/environments/revisions",
		);
		expect(built.fields).toEqual([
			{ name: "Stack", value: "Blog" },
			{ name: "Trigger", value: "Scheduled" },
			{ name: "Image", value: "nginx:1.27" },
			{ name: "Digest", value: "sha256:0123456789ab" },
			{ name: "Duration", value: "1m 05s" },
			{ name: "URL", value: "https://web.example.com" },
		]);
	});

	test("a failed build carries the commit, the error and the log tail", () => {
		const built = deployMessage(
			{
				deployment: {
					...deployment,
					errorMessage: "Build failed.",
					gitCommit: "abcdef0123456789",
					gitRef: "release",
					imageDigest: "",
					log: "\u001b[32mStep 1/3\u001b[0m\nRUN bun install\nerror: lockfile mismatch\nBuild failed.\n",
				},
				origin: null,
				stackName: null,
				publicUrl: "https://web.example.com",
				service: {
					...service,
					buildSource: "git",
					gitUrl: "https://github.com/example/web.git",
				},
				trigger: "manual",
			},
			false,
			"2026-09-16T12:01:05Z",
		);
		expect(built.event).toBe("build.failed");
		expect(built.link).toBeNull();
		expect(built.fields).toContainEqual({ name: "Commit", value: "abcdef0" });
		expect(built.fields).toContainEqual({ name: "Branch", value: "release" });
		expect(built.fields.some((field) => field.name === "URL")).toBe(false);
		expect(built.detail).toBe(
			"Build failed.\n\nStep 1/3\nRUN bun install\nerror: lockfile mismatch",
		);
	});

	test("an uptime message names the probe and the public host", () => {
		const built = uptimeMessage(
			{
				detail: "Timed out.",
				kind: "external",
				ok: false,
				origin: null,
				publicHost: "web.example.com",
				service: { id: "svc-1", name: "web" },
			},
			"2026-09-16T12:00:00Z",
		);
		expect(built.event).toBe("service.down");
		expect(built.title).toBe("web is down");
		expect(built.fields).toContainEqual({
			name: "Host",
			value: "web.example.com",
		});
	});

	test("a status checks message lists what failed and says the build stops", () => {
		const built = statusChecksMessage(
			{
				commit: "0123456789abcdef",
				failed: ["test"],
				missing: ["e2e"],
				origin: "https://homerun.example.com",
				pending: [],
				reason: "Required status checks didn't pass.",
				service: {
					gitRef: "main",
					gitUrl: "https://github.com/acme/api.git",
					id: "svc-1",
					name: "api",
				},
				stackName: null,
			},
			"2026-09-16T12:00:00Z",
		);
		expect(built.event).toBe("build.checks_failed");
		expect(built.title).toBe("api was not built: status checks failed");
		expect(built.fields).toContainEqual({
			name: "Failed checks",
			value: "test",
		});
		expect(built.fields).toContainEqual({
			name: "Never reported",
			value: "e2e",
		});
		expect(built.fields).toContainEqual({ name: "Commit", value: "0123456" });
		expect(built.detail).toContain("The build will not carry on.");
		expect(isFailureEvent("build.checks_failed")).toBe(true);
	});

	test("a revision health message is a rollback only when there was a target", () => {
		const input = {
			origin: null,
			reason: "The container exited with code 1.",
			revision: { gitCommit: null, id: "dep-2", imageRef: "nginx:1.28" },
			service: { id: "svc-1", name: "web" },
		};
		const rolled = revisionHealthMessage(
			{
				...input,
				rolledBackTo: { gitCommit: null, id: "dep-1", imageRef: "nginx:1.27" },
				skipReason: null,
			},
			"2026-09-16T12:00:00Z",
		);
		expect(rolled.event).toBe("deploy.rolled_back");
		expect(rolled.fields).toContainEqual({
			name: "Rolled back to",
			value: "nginx:1.27",
		});
		const left = revisionHealthMessage(
			{ ...input, rolledBackTo: null, skipReason: "Auto-rollback is off." },
			"2026-09-16T12:00:00Z",
		);
		expect(left.event).toBe("deploy.unhealthy");
		expect(left.detail).toBe(
			"The container exited with code 1.\n\nAuto-rollback is off.",
		);
		expect(isFailureEvent("deploy.rolled_back")).toBe(true);
	});

	test("durations and log tails", () => {
		expect(formatDuration(null, new Date())).toBeNull();
		expect(formatDuration(new Date(0), new Date(9000))).toBe("9s");
		const log = Array.from({ length: 30 }, (_, index) => `line ${index}`).join(
			"\n",
		);
		expect(logTail(log, null).split("\n")).toHaveLength(15);
		expect(logTail(log, null)).toEndWith("line 29");
	});
});

describe("withStackTitle", () => {
	test("prefixes the title with the stack, once", () => {
		const titled = withStackTitle(
			{ ...message, title: "Server was built and deployed" },
			"Vortex",
		);
		expect(titled.title).toBe("Vortex › Server was built and deployed");
		expect(withStackTitle(titled, "Vortex").title).toBe(titled.title);
	});

	test("leaves an ungrouped service's title alone", () => {
		expect(withStackTitle(message, null)).toBe(message);
	});
});

describe("ipBanMessage", () => {
	test("names the address, how long and where, linking to the blocked list", () => {
		const message = ipBanMessage(
			{
				expiresAt: new Date("2026-10-06T12:00:00Z"),
				host: "app.example.com",
				intel: {
					abuseEmail: "abuse@example.net",
					asName: "EXAMPLE-AS - Example Hosting, NL",
					asn: 64500,
					country: "NL",
					hostname: "scanner.example.net",
					lookedUpAt: "2026-10-05T12:00:01Z",
					network: "203.0.113.0/24",
					networkName: "EXAMPLE-NET",
					org: "Example Hosting",
					registry: "ripencc",
				},
				ip: "203.0.113.7",
				origin: "https://homerun.example.com",
				reason: "10 blocked requests in 10 min, last /wp-login.php",
				userAgent: "zgrab/0.x",
			},
			"2026-10-05T12:00:00Z",
		);
		expect(message).toMatchObject({
			detail: "10 blocked requests in 10 min, last /wp-login.php",
			event: "security.ip_banned",
			link: "https://homerun.example.com/monitoring/blocked",
			serviceId: null,
			title: "203.0.113.7 banned",
		});
		expect(message.fields).toEqual([
			{ name: "Address", value: "203.0.113.7" },
			{ name: "Until", value: "2026-10-06T12:00:00.000Z" },
			{ name: "Host", value: "app.example.com" },
			{
				name: "Network",
				value:
					"AS64500 EXAMPLE-AS - Example Hosting, NL · NL · scanner.example.net",
			},
			{ name: "Abuse contact", value: "abuse@example.net" },
			{ name: "User agent", value: "zgrab/0.x" },
		]);
		expect(isFailureEvent("security.ip_banned")).toBe(true);
	});

	test("a ban for good has no end and no host when none is known", () => {
		const message = ipBanMessage(
			{
				expiresAt: null,
				host: null,
				intel: null,
				ip: "198.51.100.1",
				origin: null,
				reason: "r",
				userAgent: null,
			},
			"2026-10-05T12:00:00Z",
		);
		expect(message.fields).toEqual([
			{ name: "Address", value: "198.51.100.1" },
			{ name: "Until", value: "Lifted by hand" },
		]);
		expect(message.link).toBeNull();
	});
});

describe("pushEndpoint", () => {
	test("reads the endpoint of a stored subscription", () => {
		expect(
			pushEndpoint(
				JSON.stringify({ endpoint: "https://push.example/abc", keys: {} }),
			),
		).toBe("https://push.example/abc");
	});

	test("is null for a target that isn't a subscription", () => {
		expect(pushEndpoint("not json")).toBeNull();
		expect(pushEndpoint(JSON.stringify({ endpoint: "nope" }))).toBeNull();
	});
});

describe("pushEndpointDigest", () => {
	test("is a stable hex SHA-256 that differs per endpoint", async () => {
		const first = await pushEndpointDigest("https://push.example/a");
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await pushEndpointDigest("https://push.example/a")).toBe(first);
		expect(await pushEndpointDigest("https://push.example/b")).not.toBe(first);
	});
});
