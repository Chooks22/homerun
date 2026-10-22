import { resolveTxt, reverse } from "node:dns/promises";
import {
	cymruOriginName,
	type IpIntel,
	parseCymruAsName,
	parseCymruOrigin,
	parseRdap,
} from "#lib/ip-intel.js";
import { Logger } from "#lib/logger.js";

const LOOKUP_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
	return Promise.race([
		promise.catch(() => null),
		new Promise<null>((done) => {
			setTimeout(() => done(null), LOOKUP_TIMEOUT_MS);
		}),
	]);
}

/** Looks up who is behind a client address: reverse DNS, its origin AS through Team Cymru's DNS service, and its network's owner and abuse contact over RDAP. */
class IpIntelServiceClass {
	private readonly logger = new Logger("IpIntel");

	/** The first PTR name `ip` resolves to, or null. */
	async #hostname(ip: string): Promise<string | null> {
		const names = await withTimeout(reverse(ip));
		return names?.[0] ?? null;
	}

	/** The first TXT string at `name`, or undefined. */
	async #txt(name: string): Promise<string | undefined> {
		const records = await withTimeout(resolveTxt(name));
		return records?.[0]?.join("");
	}

	/** `ip`'s origin AS, announced prefix, country and registry, plus the AS's name. */
	async #cymru(ip: string) {
		const name = cymruOriginName(ip);
		const origin = parseCymruOrigin(name ? await this.#txt(name) : undefined);
		const asName = origin.asn
			? parseCymruAsName(await this.#txt(`AS${origin.asn}.asn.cymru.com`))
			: null;
		return { ...origin, asName };
	}

	/** `ip`'s network's RDAP record, through rdap.org's bootstrap redirect to the right registry. */
	async #rdap(ip: string) {
		const body = await withTimeout(
			fetch(`https://rdap.org/ip/${encodeURIComponent(ip)}`, {
				headers: { accept: "application/rdap+json" },
				signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			}).then((res) => (res.ok ? res.json() : null)),
		);
		return parseRdap(body);
	}

	/**
	 * Everything the three sources know about `ip`, each one that fails or
	 * times out leaving its fields null. Never throws.
	 */
	async lookup(ip: string): Promise<IpIntel> {
		const [hostname, cymru, rdap] = await Promise.all([
			this.#hostname(ip),
			this.#cymru(ip),
			this.#rdap(ip),
		]);
		const intel: IpIntel = {
			abuseEmail: rdap.abuseEmail,
			asName: cymru.asName,
			asn: cymru.asn,
			country: cymru.country ?? rdap.country,
			hostname,
			lookedUpAt: new Date().toISOString(),
			network: cymru.network,
			networkName: rdap.networkName,
			org: rdap.org,
			registry: cymru.registry,
		};
		this.logger.debug(`Looked up ${ip}: ${JSON.stringify(intel)}`);
		return intel;
	}
}

export const IpIntelService = new IpIntelServiceClass();
