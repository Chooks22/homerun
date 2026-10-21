export const BANS_FILE = "homerun-bans.yml";

export const BANS_ROUTER_PRIORITY = 2_000_000_000;

export const MAX_BAN_WINDOW_MINUTES = 1440;

export const BLOCKED_STATS_DAYS = 7;

export const BLOCKED_HIT_RETENTION_MS = BLOCKED_STATS_DAYS * 86_400_000;

export interface IpBanSettings {
	disrespectMode: boolean;
	durationHours: number;
	enabled: boolean;
	meanMode: boolean;
	threshold: number;
	windowMinutes: number;
}

export const DEFAULT_IP_BAN_SETTINGS: IpBanSettings = {
	disrespectMode: false,
	durationHours: 24,
	enabled: true,
	meanMode: false,
	threshold: 10,
	windowMinutes: 10,
};

function whole(value: unknown, min: number, max: number): number | null {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
		? value
		: null;
}

/** Stored ban settings with every missing or out-of-range field at its default. */
export function withIpBanDefaults(
	stored: Partial<IpBanSettings> | null | undefined,
): IpBanSettings {
	return {
		disrespectMode:
			stored?.disrespectMode ?? DEFAULT_IP_BAN_SETTINGS.disrespectMode,
		durationHours:
			whole(stored?.durationHours, 0, 8760) ??
			DEFAULT_IP_BAN_SETTINGS.durationHours,
		enabled: stored?.enabled ?? DEFAULT_IP_BAN_SETTINGS.enabled,
		meanMode: stored?.meanMode ?? DEFAULT_IP_BAN_SETTINGS.meanMode,
		threshold:
			whole(stored?.threshold, 1, 1000) ?? DEFAULT_IP_BAN_SETTINGS.threshold,
		windowMinutes:
			whole(stored?.windowMinutes, 1, MAX_BAN_WINDOW_MINUTES) ??
			DEFAULT_IP_BAN_SETTINGS.windowMinutes,
	};
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(ip: string): number[] | null {
	const match = IPV4_RE.exec(ip);
	if (!match) {
		return null;
	}
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : null;
}

function isIpv6(ip: string): boolean {
	return (
		ip.includes(":") &&
		/^[0-9a-f:.]+$/i.test(ip) &&
		URL.canParse(`http://[${ip}]/`)
	);
}

/** `ip` trimmed, lowercased and with an IPv4-mapped IPv6 prefix dropped, or null when it isn't an IP address. */
export function normalizeIp(ip: string | null | undefined): string | null {
	const value = (ip ?? "")
		.trim()
		.toLowerCase()
		.replace(/^::ffff:/, "");
	if (ipv4Octets(value)) {
		return value;
	}
	return isIpv6(value) ? value : null;
}

/**
 * The client address Traefik settled on, which the bans router matches on:
 * its `X-Real-Ip`, which it sets to the peer it saw unless that peer is a
 * trusted proxy (Homerun's own Newt tunnel, see `tunnelTrustFlags`) that
 * already named the visitor, else the last `X-Forwarded-For` hop. Only
 * meaningful for a request known to have come through Traefik, since anyone
 * reaching the app directly can write these headers; behind an untrusted
 * proxy (Cloudflare) it's the proxy, not the visitor.
 */
export function clientIpFrom(headers: Headers): string | null {
	const forwarded = (headers.get("x-forwarded-for") ?? "")
		.split(",")
		.map((hop) => hop.trim())
		.filter(Boolean);
	return normalizeIp(headers.get("x-real-ip") ?? forwarded.at(-1));
}

export const CLOUDFLARE_RANGES = [
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
];

const NEVER_BANNED_RANGES = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"224.0.0.0/3",
	"::/128",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
];

function ipv6Value(ip: string): bigint | null {
	if (!isIpv6(ip)) {
		return null;
	}
	let text = ip;
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
	if (tail) {
		const octets = ipv4Octets(tail);
		if (!octets) {
			return null;
		}
		const [a, b, c, d] = octets;
		text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head, rest] = text.split("::");
	const split = (part: string | undefined) => (part ? part.split(":") : []);
	const groups =
		rest === undefined
			? split(head)
			: [
					...split(head),
					...Array<string>(8 - split(head).length - split(rest).length).fill(
						"0",
					),
					...split(rest),
				];
	if (groups.length !== 8) {
		return null;
	}
	return groups.reduce(
		(value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
		0n,
	);
}

function addressValue(ip: string): { bits: bigint; value: bigint } | null {
	const octets = ipv4Octets(ip);
	if (octets) {
		return {
			bits: 32n,
			value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n),
		};
	}
	const value = ipv6Value(ip);
	return value === null ? null : { bits: 128n, value };
}

/** Whether `ip` falls inside `cidr` (`address/prefix`, IPv4 or IPv6); false across families or for anything unparsable. */
export function ipInCidr(ip: string, cidr: string): boolean {
	const [base, prefix] = cidr.split("/");
	const address = addressValue(normalizeIp(ip) ?? "");
	const range = addressValue(base ?? "");
	const length = BigInt(Number(prefix));
	if (!(address && range) || address.bits !== range.bits) {
		return false;
	}
	const shift = address.bits - length;
	return address.value >> shift === range.value >> shift;
}

/**
 * Whether an address may be banned: a valid public address outside
 * Cloudflare's proxy. Loopback, private, link-local, carrier-grade NAT,
 * multicast and unspecified addresses never are, since that's where a
 * tunnel, a proxy or Docker's own network reaches Traefik from, and neither
 * is a Cloudflare edge: banning any of them would lock out every visitor
 * behind it.
 */
export function bannableIp(ip: string | null): boolean {
	const value = normalizeIp(ip);
	return (
		value !== null &&
		![...NEVER_BANNED_RANGES, ...CLOUDFLARE_RANGES].some((cidr) =>
			ipInCidr(value, cidr),
		)
	);
}

/** When a ban placed at `now` ends under `settings`, null for a ban that never does. */
export function banExpiry(settings: IpBanSettings, now: Date): Date | null {
	return settings.durationHours === 0
		? null
		: new Date(now.getTime() + settings.durationHours * 3_600_000);
}

/** The Traefik dynamic config enforcing `ips` as bans, on the peer address or the visitor a trusted proxy named, or null when there's nothing to ban. */
export function bansConfig(
	ips: string[],
	options: { dashboardHost: string | null; entrypoint: string },
): string | null {
	if (ips.length === 0) {
		return null;
	}
	const clients = ips
		.map((ip) => `ClientIP(\`${ip}\`) || Header(\`X-Real-Ip\`, \`${ip}\`)`)
		.join(" || ");
	const rule = options.dashboardHost
		? `(${clients}) && !Host(\`${options.dashboardHost}\`)`
		: clients;
	return JSON.stringify(
		{
			http: {
				middlewares: {
					"homerun-banned": {
						ipAllowList: { sourceRange: ["127.0.0.1/32"] },
					},
				},
				routers: {
					"homerun-banned": {
						entryPoints: [options.entrypoint],
						middlewares: ["homerun-banned"],
						priority: BANS_ROUTER_PRIORITY,
						rule,
						service: "noop@internal",
						tls: {},
					},
				},
			},
		},
		null,
		2,
	);
}

/**
 * Whether `ip`, having made `hits` counted blocked requests within the
 * window, gets banned now: bans are on, the address may be banned (see
 * `bannableIp`) and the threshold is reached.
 */
export function shouldBan(params: {
	hits: number;
	ip: string;
	settings: IpBanSettings;
}): boolean {
	return (
		params.settings.enabled &&
		bannableIp(params.ip) &&
		params.hits >= params.settings.threshold
	);
}
