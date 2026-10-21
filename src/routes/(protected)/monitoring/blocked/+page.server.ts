import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { BlockedHitDTO } from "#lib/dto/blocked-hit-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { IpBanDTO } from "#lib/dto/ip-ban-dto.js";
import { BLOCKED_STATS_DAYS, bannableIp, normalizeIp } from "#lib/ip-bans.js";
import { Logger } from "#lib/logger.js";
import { can, permissionDeniedMessage } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { IpBanService } from "#lib/services/ip-ban.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("IpBans");

export const load = async ({ locals, parent }) => {
	await parent();
	if (!can(locals.permissions, "settings", "read")) {
		throw redirect(302, resolve("/(protected)/monitoring"));
	}
	const settings = (await InstanceSettingsDTO.get()).ipBans;
	const [bans, counting, summary] = await Promise.all([
		IpBanDTO.listActive(),
		BlockedHitDTO.addressesSince(
			new Date(Date.now() - settings.windowMinutes * 60_000),
		),
		BlockedHitDTO.summarySince(
			new Date(Date.now() - BLOCKED_STATS_DAYS * 86_400_000),
		),
	]);
	return {
		bans: bans.map((ban) => ban.toJSON()),
		counting: settings.enabled
			? counting.filter((address) => bannableIp(address.ip))
			: [],
		ipBans: settings,
		statsDays: BLOCKED_STATS_DAYS,
		summary,
		published: Boolean(config.traefik.dynamicConfigDir),
	};
};

export const actions = {
	unban: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!can(locals.permissions, "settings", "write")) {
			return fail(403, { error: permissionDeniedMessage("settings", "write") });
		}
		const ip = normalizeIp(String((await request.formData()).get("ip")));
		if (!(ip && (await IpBanService.unban(ip)))) {
			return fail(404, { error: "That address isn't banned." });
		}
		logger.info(`IP unbanned: ip=${ip} user=${locals.user.id}`);
		return { success: true };
	},
};
