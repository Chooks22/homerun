import { describe, expect, test } from "bun:test";
import {
	BANS_ROUTER_PRIORITY,
	banExpiry,
	bannableIp,
	bansConfig,
	CLOUDFLARE_RANGES,
	clientIpFrom,
	DEFAULT_IP_BAN_SETTINGS,
	ipInCidr,
	normalizeIp,
	shouldBan,
	withIpBanDefaults,
} from "../../../src/lib/ip-bans";

describe("IP ban settings", () => {
	test("nothing stored gives the defaults: on, 10 hits in 10 minutes, 24 hours", () => {
		expect(withIpBanDefaults(null)).toEqual(DEFAULT_IP_BAN_SETTINGS);
		expect(DEFAULT_IP_BAN_SETTINGS).toEqual({
			durationHours: 24,
			enabled: true,
			threshold: 10,
			windowMinutes: 10,
		});
	});

	test("stored values are kept, out-of-range ones fall back", () => {
		expect(
			withIpBanDefaults({
				durationHours: 0,
				enabled: false,
				threshold: 3,
				windowMinutes: 5,
			}),
		).toEqual({
			durationHours: 0,
			enabled: false,
			threshold: 3,
			windowMinutes: 5,
		});
		expect(
			withIpBanDefaults({
				durationHours: -1,
				threshold: 0,
				windowMinutes: 1.5,
			}),
		).toEqual(DEFAULT_IP_BAN_SETTINGS);
	});

	test("a ban ends after its duration, or never at 0 hours", () => {
		const now = new Date("2026-10-05T12:00:00Z");
		expect(banExpiry(DEFAULT_IP_BAN_SETTINGS, now)?.toISOString()).toBe(
			"2026-10-06T12:00:00.000Z",
		);
		expect(
			banExpiry({ ...DEFAULT_IP_BAN_SETTINGS, durationHours: 0 }, now),
		).toBeNull();
	});
});

describe("client address", () => {
	test("is Traefik's X-Real-Ip, else the last X-Forwarded-For hop", () => {
		expect(
			clientIpFrom(
				new Headers({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }),
			),
		).toBe("203.0.113.9");
		expect(
			clientIpFrom(
				new Headers({
					"x-forwarded-for": "198.51.100.7, 172.18.0.5",
					"x-real-ip": "198.51.100.7",
				}),
			),
		).toBe("198.51.100.7");
		expect(clientIpFrom(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe(
			"203.0.113.9",
		);
		expect(clientIpFrom(new Headers())).toBeNull();
		expect(
			clientIpFrom(new Headers({ "x-forwarded-for": "not-an-ip" })),
		).toBeNull();
	});

	test("is normalised, IPv4-mapped IPv6 included", () => {
		expect(normalizeIp(" ::FFFF:203.0.113.9 ")).toBe("203.0.113.9");
		expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
		expect(normalizeIp("256.1.1.1")).toBeNull();
		expect(normalizeIp("1:2:3")).toBeNull();
		expect(normalizeIp("gggg::1")).toBeNull();
		expect(normalizeIp(null)).toBeNull();
	});

	test("only a public address can be banned", () => {
		for (const ip of [
			"203.0.113.9",
			"8.8.8.8",
			"172.32.0.1",
			"100.128.0.1",
			"2001:db8::1",
		]) {
			expect(bannableIp(ip)).toBe(true);
		}
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.18.0.5",
			"192.168.1.10",
			"169.254.0.1",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"::",
			"fd00::1",
			"fe80::1",
			"ff02::1",
			"nope",
			null,
		]) {
			expect(bannableIp(ip)).toBe(false);
		}
	});
});

describe("address ranges", () => {
	test("CIDR matching works for both families and nothing across them", () => {
		expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
		expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
		expect(ipInCidr("172.31.255.255", "172.16.0.0/12")).toBe(true);
		expect(ipInCidr("172.32.0.0", "172.16.0.0/12")).toBe(false);
		expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
		expect(ipInCidr("2606:4700:10::6816:1", "2606:4700::/32")).toBe(true);
		expect(ipInCidr("2606:4701::1", "2606:4700::/32")).toBe(false);
		expect(ipInCidr("2a06:98c7::1", "2a06:98c0::/29")).toBe(true);
		expect(ipInCidr("2a06:98c8::1", "2a06:98c0::/29")).toBe(false);
		expect(ipInCidr("::ffff:10.0.0.1", "10.0.0.0/8")).toBe(true);
		expect(ipInCidr("64:ff9b::1.2.3.4", "64:ff9b::/96")).toBe(true);
		expect(ipInCidr("10.0.0.1", "fc00::/7")).toBe(false);
		expect(ipInCidr("nope", "10.0.0.0/8")).toBe(false);
	});

	test("every Cloudflare edge range is exempt from bans", () => {
		for (const cidr of CLOUDFLARE_RANGES) {
			const base = cidr.split("/")[0] ?? "";
			expect(bannableIp(base)).toBe(false);
		}
		expect(bannableIp("172.67.1.1")).toBe(false);
		expect(bannableIp("2400:cb00:2049::1")).toBe(false);
		expect(bannableIp("172.72.1.1")).toBe(true);
	});
});

describe("ban threshold", () => {
	const settings = DEFAULT_IP_BAN_SETTINGS;
	const ip = "203.0.113.9";

	test("bans once the hits reach the threshold", () => {
		expect(shouldBan({ hits: 9, ip, settings })).toBe(false);
		expect(shouldBan({ hits: 10, ip, settings })).toBe(true);
	});

	test("never bans with bans off, a Cloudflare edge, or a private address", () => {
		expect(
			shouldBan({
				hits: 50,
				ip,
				settings: { ...settings, enabled: false },
			}),
		).toBe(false);
		expect(shouldBan({ hits: 50, ip: "104.16.1.1", settings })).toBe(false);
		expect(shouldBan({ hits: 50, ip: "10.0.0.2", settings })).toBe(false);
	});
});

describe("bans file", () => {
	test("nothing banned, no file", () => {
		expect(
			bansConfig([], { dashboardHost: null, entrypoint: "websecure" }),
		).toBeNull();
	});

	test("one deny router at the top priority matches every banned address but the dashboard", () => {
		const config = JSON.parse(
			bansConfig(["203.0.113.9", "2001:db8::1"], {
				dashboardHost: "homerun.example.org",
				entrypoint: "websecure",
			}) ?? "",
		);
		expect(config.http.routers["homerun-banned"]).toEqual({
			entryPoints: ["websecure"],
			middlewares: ["homerun-banned"],
			priority: BANS_ROUTER_PRIORITY,
			rule: "(ClientIP(`203.0.113.9`) || Header(`X-Real-Ip`, `203.0.113.9`) || ClientIP(`2001:db8::1`) || Header(`X-Real-Ip`, `2001:db8::1`)) && !Host(`homerun.example.org`)",
			service: "noop@internal",
			tls: {},
		});
		expect(config.http.middlewares["homerun-banned"]).toEqual({
			ipAllowList: { sourceRange: ["127.0.0.1/32"] },
		});
	});

	test("without a dashboard host the rule is the addresses alone", () => {
		const config = JSON.parse(
			bansConfig(["203.0.113.9"], {
				dashboardHost: null,
				entrypoint: "websecure",
			}) ?? "",
		);
		expect(config.http.routers["homerun-banned"].rule).toBe(
			"ClientIP(`203.0.113.9`) || Header(`X-Real-Ip`, `203.0.113.9`)",
		);
	});
});
