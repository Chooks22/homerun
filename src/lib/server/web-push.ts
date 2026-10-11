import { importJWK, SignJWT } from "jose";
import { z } from "zod";

const RECORD_SIZE = 4096;
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

export const pushSubscriptionSchema = z.object({
	endpoint: z
		.string()
		.url()
		.refine((value) => value.startsWith("https://"), {
			error: "A push endpoint must be an https URL.",
		}),
	keys: z.object({
		auth: z.string().min(1),
		p256dh: z.string().min(1),
	}),
});

export type PushSubscriptionJSON = z.infer<typeof pushSubscriptionSchema>;

export interface VapidKeys {
	/** The private key's `d` component, base64url. */
	privateKey: string;
	/** The uncompressed P-256 public key (65 bytes), base64url: the browser's `applicationServerKey`. */
	publicKey: string;
}

export interface PushPayload {
	body: string;
	tag: string;
	title: string;
	url: string;
}

export class PushSubscriptionGoneError extends Error {}

const encoder = new TextEncoder();

/** Encodes bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Decodes base64url (padded or not, or plain base64) into bytes. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(text, "base64url"));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	length: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ hash: "SHA-256", info, name: "HKDF", salt },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

/** Generates a new VAPID key pair, the server's identity towards every push service. */
export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const raw = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	if (!jwk.d) {
		throw new Error("The generated VAPID key has no private component.");
	}
	return { privateKey: jwk.d, publicKey: toBase64Url(raw) };
}

/**
 * Builds the `Authorization` header value (RFC 8292) for a push to
 * `endpoint`: an ES256 JWT for the endpoint's origin plus the public key.
 */
export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	subject: string,
	now = new Date(),
): Promise<string> {
	const raw = fromBase64Url(keys.publicKey);
	const key = await importJWK(
		{
			crv: "P-256",
			d: keys.privateKey,
			kty: "EC",
			x: toBase64Url(raw.slice(1, 33)),
			y: toBase64Url(raw.slice(33, 65)),
		},
		"ES256",
	);
	const issuedAt = Math.floor(now.getTime() / 1000);
	const token = await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", typ: "JWT" })
		.setAudience(new URL(endpoint).origin)
		.setExpirationTime(issuedAt + VAPID_TTL_SECONDS)
		.setSubject(subject)
		.sign(key);
	return `vapid t=${token}, k=${keys.publicKey}`;
}

/**
 * Encrypts a push message body for one subscription (RFC 8291, the
 * `aes128gcm` content coding): a fresh ECDH key pair and salt per message, a
 * single record. `ephemeral` and `salt` are only passed by tests.
 */
export async function encryptPushPayload(
	subscription: PushSubscriptionJSON,
	plaintext: Uint8Array,
	ephemeral?: CryptoKeyPair,
	salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = fromBase64Url(subscription.keys.p256dh);
	const authSecret = fromBase64Url(subscription.keys.auth);
	const pair =
		ephemeral ??
		(await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"],
		));
	const asPublic = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	const uaKey = await crypto.subtle.importKey(
		"raw",
		uaPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: uaKey },
			pair.privateKey,
			256,
		),
	);
	const ikm = await hkdf(
		authSecret,
		ecdhSecret,
		concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic),
		32,
	);
	const cek = await hkdf(
		salt,
		ikm,
		encoder.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdf(
		salt,
		ikm,
		encoder.encode("Content-Encoding: nonce\0"),
		12,
	);
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
		"encrypt",
	]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ iv: nonce, name: "AES-GCM" },
			aesKey,
			concat(plaintext, new Uint8Array([2])),
		),
	);
	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	return concat(header, asPublic, ciphertext);
}

/**
 * Sends one encrypted push message to a subscription's push service.
 *
 * @throws `PushSubscriptionGoneError` when the push service says the
 *   subscription no longer exists (404/410); a plain `Error` on a timeout or
 *   any other non-2xx answer.
 */
export async function sendWebPush(
	subscription: PushSubscriptionJSON,
	payload: PushPayload,
	keys: VapidKeys,
	subject: string,
): Promise<void> {
	const body = await encryptPushPayload(
		subscription,
		encoder.encode(JSON.stringify(payload)),
	);
	let response: Response;
	try {
		response = await fetch(subscription.endpoint, {
			body,
			headers: {
				authorization: await vapidAuthorization(
					subscription.endpoint,
					keys,
					subject,
				),
				"content-encoding": "aes128gcm",
				"content-type": "application/octet-stream",
				ttl: String(PUSH_TTL_SECONDS),
				urgency: "high",
			},
			method: "POST",
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new Error(
			err instanceof Error && err.name === "TimeoutError"
				? "The push service timed out."
				: "The push service couldn't be reached.",
		);
	}
	if (response.status === 404 || response.status === 410) {
		throw new PushSubscriptionGoneError(
			"This browser's push subscription expired. Turn browser notifications on again from it.",
		);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`The push service returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
		);
	}
}
