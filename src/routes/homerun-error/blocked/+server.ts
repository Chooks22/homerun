import { baitFor, insult } from "#lib/bait.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { forwardedHost } from "#lib/error-pages.js";
import { Logger } from "#lib/logger.js";
import { ErrorPageService } from "#lib/services/error-page.service.js";
import { IpBanService } from "#lib/services/ip-ban.service.js";

const logger = new Logger("IpBans");

export const fallback = async ({ request }) => {
	const host = forwardedHost(request.headers);
	const { disrespectMode, meanMode } = (await InstanceSettingsDTO.get()).ipBans;
	const path = (request.headers.get("x-replaced-path") ?? "").split("?")[0];
	const bait =
		meanMode || disrespectMode ? baitFor(path ?? "", disrespectMode) : null;
	const rant = !bait && disrespectMode ? `${insult()}\n` : null;
	const junk = bait?.body ?? rant;
	const baitBytes = junk ? new Blob([junk]).size : 0;
	await IpBanService.recordBlockedHit(request.headers, host, baitBytes).catch(
		(err) => logger.error("Couldn't record a blocked request", err),
	);
	if (bait) {
		return new Response(bait.body, {
			headers: {
				"cache-control": "no-store",
				"content-type": bait.contentType,
			},
		});
	}
	if (rant) {
		return new Response(rant, {
			headers: { "content-type": "text/plain; charset=utf-8" },
			status: 403,
		});
	}
	return await ErrorPageService.respond(403, host, "blocked");
};
