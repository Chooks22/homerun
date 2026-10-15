export const SCALE_TO_ZERO_MIN_MINUTES = 1;

export const SCALE_TO_ZERO_MAX_MINUTES = 1440;

/**
 * Whether a service with scale to zero on has gone `minutes` without a
 * request. The idle clock starts at the latest of its last request, its last
 * wake and the moment the traffic sampler started watching, since nothing
 * before that last one was seen.
 */
export function shouldSleep(input: {
	lastRequestAt: Date | null;
	minutes: number;
	now: Date;
	watchingSince: Date;
	wokenAt: Date | null;
}): boolean {
	const since = Math.max(
		input.lastRequestAt?.getTime() ?? 0,
		input.wokenAt?.getTime() ?? 0,
		input.watchingSince.getTime(),
	);
	return input.now.getTime() - since >= input.minutes * 60_000;
}

/**
 * Where to send a request that woke a service back to: the path Traefik's
 * catch-all router replaced (`X-Replaced-Path`) with the request's own query,
 * or null when the request didn't come through it and there's nothing to
 * send it back to.
 */
export function wakeRedirectTarget(
	replacedPath: string | null,
	search: string,
): string | null {
	if (!replacedPath?.startsWith("/") || replacedPath.startsWith("//")) {
		return null;
	}
	return `${replacedPath}${search}`;
}

/** "Sleeps after 15 minutes without a request" and the like, for the Compute tab and the Overview. */
export function scaleToZeroLabel(minutes: number): string {
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `Sleeps after ${hours} hour${hours === 1 ? "" : "s"} without a request`;
	}
	return `Sleeps after ${minutes} minute${minutes === 1 ? "" : "s"} without a request`;
}
