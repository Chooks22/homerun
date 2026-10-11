import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import {
	generateVapidKeys,
	type PushPayload,
	type PushSubscriptionJSON,
	sendWebPush,
	type VapidKeys,
} from "#lib/server/web-push.js";
import { decryptSecret, encryptSecret } from "./secrets";

const logger = new Logger("WebPush");

const FALLBACK_SUBJECT = "mailto:admin@homerun.invalid";

class WebPushServiceClass {
	#keys: Promise<VapidKeys> | null = null;

	/**
	 * The instance's VAPID key pair, generated and stored (private half
	 * encrypted) the first time anything asks. Cached for the process.
	 */
	keys(): Promise<VapidKeys> {
		this.#keys ??= this.#loadOrCreateKeys().catch((err) => {
			this.#keys = null;
			throw err;
		});
		return this.#keys;
	}

	/** The public half of the VAPID key pair, the `applicationServerKey` a browser subscribes with. */
	async publicKey(): Promise<string> {
		return (await this.keys()).publicKey;
	}

	/**
	 * Sends one push message to a browser subscription.
	 *
	 * @throws `PushSubscriptionGoneError` when the subscription expired, or an
	 *   `Error` when the push service refused or couldn't be reached.
	 */
	async send(
		subscription: PushSubscriptionJSON,
		payload: PushPayload,
	): Promise<void> {
		await sendWebPush(
			subscription,
			payload,
			await this.keys(),
			this.#subject(),
		);
	}

	/** Who the push services can contact about this sender: the SMTP from address, else an https dashboard origin. */
	#subject(): string {
		const from = config.smtp.from?.match(/[^<\s]+@[^>\s]+/)?.[0];
		if (from) {
			return `mailto:${from}`;
		}
		const origin = config.auth.origin;
		return origin?.startsWith("https://") ? origin : FALLBACK_SUBJECT;
	}

	/**
	 * Reads the stored key pair, or generates and stores one when there's none
	 * or the stored private key no longer decrypts (the auth secret changed,
	 * which also invalidates every existing browser subscription).
	 */
	async #loadOrCreateKeys(): Promise<VapidKeys> {
		const settings = await InstanceSettingsDTO.get();
		const row = settings.toJSON();
		const privateKey = row.vapidPrivateKeyEnc
			? decryptSecret(row.vapidPrivateKeyEnc)
			: null;
		if (row.vapidPublicKey && privateKey) {
			return { privateKey, publicKey: row.vapidPublicKey };
		}
		const keys = await generateVapidKeys();
		await settings.persistVapid({
			vapidPrivateKeyEnc: encryptSecret(keys.privateKey),
			vapidPublicKey: keys.publicKey,
		});
		logger.info("Generated a new Web Push key pair");
		return keys;
	}
}

export const WebPushService = new WebPushServiceClass();
