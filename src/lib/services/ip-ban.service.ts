import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "#lib/config.js";
import { BlockedHitDTO } from "#lib/dto/blocked-hit-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { IpBanDTO } from "#lib/dto/ip-ban-dto.js";
import {
	BANS_FILE,
	BLOCKED_HIT_RETENTION_MS,
	banExpiry,
	bannableIp,
	bansConfig,
	clientIpFrom,
	shouldBan,
} from "#lib/ip-bans.js";
import { Logger } from "#lib/logger.js";
import { matchingPathPattern } from "#lib/path-patterns.js";
import { CrowdsecService } from "./crowdsec.service.ts";
import { dashboardHostFrom } from "./docker/dashboard.ts";
import {
	BLOCKED_PROOF_HEADER,
	validBlockedProof,
} from "./docker/error-pages.ts";
import { NotificationChannelService } from "./notification-channel.service.ts";
import { ipBanMessage } from "./notification-messages.ts";
import { serviceForHost } from "./service-for-host.ts";

/** Counts requests to services' blocked paths per client address and bans the ones that keep trying, through a Traefik file-provider router. */
class IpBanServiceClass {
	private readonly logger = new Logger("IpBans");

	/**
	 * Records one request a blocked-paths router sent to the blocked page,
	 * with the service and pattern it hit and the bait bytes it got back, and
	 * bans its client address once it crosses the instance's threshold (see
	 * `shouldBan`), rewriting the bans file. Only a request carrying Traefik's
	 * proof header is believed, since the page is reachable without going
	 * through Traefik. Every such request is kept for the blocked-requests
	 * stats; only bans being on and a bannable address lead on to a ban.
	 */
	async recordBlockedHit(
		headers: Headers,
		host: string | null,
		baitBytes: number,
	): Promise<void> {
		if (
			!validBlockedProof(headers.get(BLOCKED_PROOF_HEADER), config.auth.secret)
		) {
			return;
		}
		const ip = clientIpFrom(headers);
		if (!ip || (await IpBanDTO.isBanned(ip))) {
			return;
		}
		const path = headers.get("x-replaced-path")?.slice(0, 500) ?? null;
		const service = host ? await serviceForHost(host) : null;
		await BlockedHitDTO.record({
			baitBytes,
			host,
			ip,
			path,
			pattern: matchingPathPattern(service?.blockedPaths ?? [], path),
			serviceId: service?.id ?? null,
		});
		const settings = (await InstanceSettingsDTO.get()).ipBans;
		if (!(settings.enabled && bannableIp(ip))) {
			return;
		}
		const now = new Date();
		const hits = await BlockedHitDTO.countSince(
			ip,
			new Date(now.getTime() - settings.windowMinutes * 60_000),
		);
		if (!shouldBan({ hits, ip, settings })) {
			return;
		}
		const expiresAt = banExpiry(settings, now);
		const reason = `${hits} blocked requests in ${settings.windowMinutes} min${path ? `, last ${path}` : ""}`;
		const banned = await IpBanDTO.ban({ expiresAt, host, ip, reason });
		if (banned) {
			this.logger.warn(
				`Banned ${ip} after ${hits} blocked requests${host ? ` on ${host}` : ""}`,
			);
			await this.sync();
			void CrowdsecService.ban(ip, settings.durationHours, reason);
			NotificationChannelService.notify(
				ipBanMessage(
					{
						expiresAt,
						host,
						ip,
						origin: config.auth.origin ?? null,
						reason,
					},
					now.toISOString(),
				),
			);
		}
	}

	/** Lifts the ban on `ip`, rewrites the bans file and deletes the address's CrowdSec decisions. Returns whether there was a ban here. */
	async unban(ip: string): Promise<boolean> {
		const removed = await IpBanDTO.unban(ip);
		if (removed) {
			await this.sync();
			void CrowdsecService.unban(ip);
		}
		return removed;
	}

	/** Drops expired bans (rewriting the bans file when any went) and blocked requests older than the stats keep them. */
	async prune(): Promise<void> {
		const now = new Date();
		await BlockedHitDTO.deleteBefore(
			new Date(now.getTime() - BLOCKED_HIT_RETENTION_MS),
		);
		if ((await IpBanDTO.deleteExpired(now)) > 0) {
			await this.sync();
		}
	}

	/**
	 * Rewrites `homerun-bans.yml` in Traefik's dynamic config directory from
	 * the bans in force, or removes it when there are none. Does nothing
	 * without a directory; failures are logged, not thrown.
	 */
	async sync(): Promise<void> {
		const dir = config.traefik.dynamicConfigDir;
		if (!dir) {
			return;
		}
		const path = join(dir, BANS_FILE);
		try {
			const content = bansConfig(await IpBanDTO.activeIps(), {
				dashboardHost: dashboardHostFrom(config.auth.origin ?? null),
				entrypoint: config.traefik.entrypoint,
			});
			if (content === null) {
				await rm(path, { force: true });
				return;
			}
			await mkdir(dir, { recursive: true });
			await writeFile(path, content);
		} catch (err) {
			this.logger.error("Couldn't publish the IP bans", err);
		}
	}
}

export const IpBanService = new IpBanServiceClass();
