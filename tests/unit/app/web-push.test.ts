import { describe, expect, mock, test } from "bun:test";
import { importJWK, jwtVerify } from "jose";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	encryptPushPayload,
	fromBase64Url,
	generateVapidKeys,
	toBase64Url,
	vapidAuthorization,
} = await import("../../../src/lib/server/web-push");
const { pushPayload } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { deployStartedMessage } = await import(
	"../../../src/lib/services/notification-messages"
);
const { DEFAULT_BROWSER_EVENTS, deployStartedEvent, isFailureEvent } =
	await import("../../../src/lib/notification-events");
const { browserDeviceName } = await import("../../../src/lib/browser-device");
const { channelTargetLabel, pushServiceHost } = await import(
	"../../../src/lib/notification-channel-target"
);
const { channelTargetFromForm, validateChannelTarget } = await import(
	"../../../src/lib/server/validation/notification-channel"
);

const encoder = new TextEncoder();

async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: string | Uint8Array<ArrayBuffer>,
	length: number,
) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
		"deriveBits",
	]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				hash: "SHA-256",
				info: typeof info === "string" ? encoder.encode(info) : info,
				name: "HKDF",
				salt,
			},
			key,
			length * 8,
		),
	);
}

async function userAgent() {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		auth,
		pair,
		publicKey,
		subscription: {
			endpoint: "https://push.example.com/send/abc",
			keys: { auth: toBase64Url(auth), p256dh: toBase64Url(publicKey) },
		},
	};
}

async function decrypt(
	ua: Awaited<ReturnType<typeof userAgent>>,
	body: Uint8Array<ArrayBuffer>,
) {
	const salt = body.slice(0, 16);
	const recordSize = new DataView(body.buffer).getUint32(16);
	const idLength = body[20];
	const asPublic = body.slice(21, 21 + idLength);
	const ciphertext = body.slice(21 + idLength);
	const asKey = await crypto.subtle.importKey(
		"raw",
		asPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const secret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: asKey },
			ua.pair.privateKey,
			256,
		),
	);
	const info = new Uint8Array([
		...encoder.encode("WebPush: info\0"),
		...ua.publicKey,
		...asPublic,
	]);
	const ikm = await hkdf(ua.auth, secret, info, 32);
	const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
	const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
		"decrypt",
	]);
	const padded = new Uint8Array(
		await crypto.subtle.decrypt(
			{ iv: nonce, name: "AES-GCM" },
			key,
			ciphertext,
		),
	);
	return {
		delimiter: padded.at(-1),
		idLength,
		recordSize,
		text: new TextDecoder().decode(padded.slice(0, -1)),
	};
}

describe("encryptPushPayload", () => {
	test("produces an aes128gcm body the subscribing browser can decrypt", async () => {
		const ua = await userAgent();
		const body = await encryptPushPayload(
			ua.subscription,
			encoder.encode('{"title":"api is building"}'),
		);
		const out = await decrypt(ua, body);
		expect(out.text).toBe('{"title":"api is building"}');
		expect(out.delimiter).toBe(2);
		expect(out.idLength).toBe(65);
		expect(out.recordSize).toBe(4096);
	});

	test("uses a fresh key and salt for every message", async () => {
		const ua = await userAgent();
		const plaintext = encoder.encode("same");
		const a = await encryptPushPayload(ua.subscription, plaintext);
		const b = await encryptPushPayload(ua.subscription, plaintext);
		expect(toBase64Url(a)).not.toBe(toBase64Url(b));
	});
});

describe("vapidAuthorization", () => {
	test("signs an ES256 JWT for the endpoint's origin that verifies with the public key", async () => {
		const keys = await generateVapidKeys();
		expect(fromBase64Url(keys.publicKey)).toHaveLength(65);
		const header = await vapidAuthorization(
			"https://fcm.googleapis.com/fcm/send/xyz",
			keys,
			"mailto:ops@example.com",
			new Date("2026-01-01T00:00:00Z"),
		);
		const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
		expect(match?.[2]).toBe(keys.publicKey);
		const raw = fromBase64Url(keys.publicKey);
		const publicKey = await importJWK(
			{
				crv: "P-256",
				kty: "EC",
				x: toBase64Url(raw.slice(1, 33)),
				y: toBase64Url(raw.slice(33)),
			},
			"ES256",
		);
		const { payload } = await jwtVerify(match?.[1] ?? "", publicKey, {
			currentDate: new Date("2026-01-01T01:00:00Z"),
		});
		expect(payload.aud).toBe("https://fcm.googleapis.com");
		expect(payload.sub).toBe("mailto:ops@example.com");
		expect(payload.exp).toBe(Date.parse("2026-01-01T12:00:00Z") / 1000);
	});
});

describe("deploy started events", () => {
	test("a git build is build.started, anything reusing an image is deploy.started", () => {
		expect(deployStartedEvent("git", "manual", false)).toBe("build.started");
		expect(deployStartedEvent("git", "push", false)).toBe("build.started");
		expect(deployStartedEvent("git", "promote", false)).toBe("deploy.started");
		expect(deployStartedEvent("git", "manual", true)).toBe("deploy.started");
		expect(deployStartedEvent("image", "manual", false)).toBe("deploy.started");
	});

	test("neither is a failure, and browser channels get build starts by default", () => {
		expect(isFailureEvent("build.started")).toBe(false);
		expect(isFailureEvent("deploy.started")).toBe(false);
		expect(DEFAULT_BROWSER_EVENTS).toContain("build.started");
		expect(DEFAULT_BROWSER_EVENTS).toContain("build.failed");
	});

	test("the started message names the service, source and trigger", () => {
		const message = deployStartedMessage(
			{
				deployment: {
					errorMessage: null,
					finishedAt: null,
					gitCommit: null,
					gitRef: "main",
					imageDigest: null,
					log: null,
					startedAt: new Date(),
				},
				origin: "https://homerun.example.com",
				publicUrl: null,
				rollback: false,
				service: {
					buildSource: "git",
					gitRef: "main",
					gitUrl: "https://github.com/example/app.git",
					id: "svc1",
					image: "",
					name: "api",
					tag: "latest",
				},
				stackName: "Prod",
				trigger: "push",
			},
			"2026-01-01T00:00:00.000Z",
		);
		expect(message.event).toBe("build.started");
		expect(message.title).toBe("api is building");
		expect(message.link).toBe("https://homerun.example.com/services/svc1");
		expect(message.fields).toEqual([
			{ name: "Stack", value: "Prod" },
			{ name: "Trigger", value: "Git push" },
			{ name: "Repository", value: "https://github.com/example/app.git" },
			{ name: "Branch", value: "main" },
		]);
	});
});

describe("pushPayload", () => {
	const base = {
		detail: null,
		event: "build.started" as const,
		fields: [{ name: "Branch", value: "main" }],
		link: null,
		serviceId: "svc1",
		serviceName: "api",
		timestamp: "2026-01-01T00:00:00.000Z",
		title: "api is building",
	};

	test("a start and its outcome share a tag, so the outcome replaces it", () => {
		const started = pushPayload(base);
		const failed = pushPayload({
			...base,
			detail: "Build failed.\n\nstep 3/7",
			event: "build.failed",
			title: "api failed to build",
		});
		expect(started.tag).toBe("svc1:build");
		expect(failed.tag).toBe(started.tag);
		expect(started.body).toBe("Service: api · Branch: main");
		expect(failed.body).toBe("Build failed.");
	});

	test("links to the service when no dashboard origin is set", () => {
		expect(pushPayload(base).url).toBe("/services/svc1");
		expect(pushPayload({ ...base, link: "https://h.example.com/x" }).url).toBe(
			"https://h.example.com/x",
		);
		expect(
			pushPayload({ ...base, serviceId: null, serviceName: null }).url,
		).toBe("/notifications");
	});
});

describe("browser channel targets", () => {
	const target = JSON.stringify({
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		keys: { auth: "x", p256dh: "y" },
	});

	test("show only the push service, never the keys", () => {
		expect(pushServiceHost(target)).toBe("fcm.googleapis.com");
		expect(channelTargetLabel("browser", target)).toBe(
			"Push via fcm.googleapis.com",
		);
		expect(channelTargetLabel("browser", "nope")).toBe(
			"Push via unknown service",
		);
	});

	test("validate as an https push subscription", () => {
		expect(validateChannelTarget("browser", target)).toBeNull();
		expect(
			validateChannelTarget("browser", "https://x.example"),
		).not.toBeNull();
		expect(
			validateChannelTarget(
				"browser",
				JSON.stringify({
					endpoint: "http://push.example.com",
					keys: { auth: "x", p256dh: "y" },
				}),
			),
		).not.toBeNull();
	});

	test("an edit keeps the stored subscription", () => {
		const form = new FormData();
		form.set("target", "https://evil.example");
		expect(channelTargetFromForm(form, { kind: "browser", target })).toBe(
			target,
		);
	});
});

describe("browserDeviceName", () => {
	test("names the browser and system", () => {
		expect(
			browserDeviceName(
				"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
			),
		).toBe("Firefox on Linux");
		expect(
			browserDeviceName(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
			),
		).toBe("Edge on Windows");
		expect(
			browserDeviceName(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
			),
		).toBe("Safari on macOS");
		expect(
			browserDeviceName(
				"Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
			),
		).toBe("Chrome on Android");
		expect(browserDeviceName("curl/8")).toBe("Browser");
	});
});
