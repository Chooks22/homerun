import { BlockedHitDTO } from "#lib/dto/blocked-hit-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { IpBanDTO } from "#lib/dto/ip-ban-dto.js";
import { BLOCKED_STATS_DAYS } from "#lib/ip-bans.js";
import { can } from "#lib/permissions.js";

export const load = async ({ locals, parent }) => {
	const { service } = await parent();
	const since = new Date(Date.now() - BLOCKED_STATS_DAYS * 86_400_000);
	const [summary, addresses, banned, settings] = await Promise.all([
		BlockedHitDTO.summarySince(since, service.id),
		BlockedHitDTO.addressesSince(since, 100, service.id),
		IpBanDTO.activeIps(),
		InstanceSettingsDTO.get(),
	]);
	const bannedIps = new Set(banned);
	return {
		addresses: addresses.map((address) => ({
			...address,
			banned: bannedIps.has(address.ip),
		})),
		baiting: settings.ipBans.meanMode || settings.ipBans.disrespectMode,
		blockedPaths: service.blockedPaths,
		canManageBans: can(locals.permissions, "settings", "read"),
		statsDays: BLOCKED_STATS_DAYS,
		summary,
	};
};
