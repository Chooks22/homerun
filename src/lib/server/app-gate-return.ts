import { verifyGateToken } from "#lib/server/app-gate.js";
import { gateTarget } from "#lib/server/gate-target.js";

export const APP_AUTH_PATH = "/app-auth";

/**
 * The gated app's name and allowed sign-in methods when `returnPath` is a
 * login-wall return path (`/app-auth?rd=<signed token>`) for a service or
 * workstation that's still gated, so the sign-in page can say which app the
 * visitor is signing in to and offer only the methods its wall accepts. A
 * workstation's methods are null, every method: its owner always gets in,
 * whichever one they use. Null for any other path, or an invalid or expired
 * token.
 */
export async function gatedAppFor(
	returnPath: string | null,
): Promise<{ methods: string[] | null; name: string } | null> {
	if (!returnPath) {
		return null;
	}
	const parsed = new URL(returnPath, "http://homerun.invalid");
	if (parsed.pathname !== APP_AUTH_PATH) {
		return null;
	}
	const rd = parsed.searchParams.get("rd");
	const request = rd ? verifyGateToken(rd) : null;
	if (!request) {
		return null;
	}
	const gated = await gateTarget(request.serviceId);
	if (!gated?.authRequired) {
		return null;
	}
	return {
		methods: gated.ownerId ? null : gated.authProviders,
		name: gated.name,
	};
}
