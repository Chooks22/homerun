import { fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { auth } from "#lib/services/auth.js";

const logger = new Logger("Sessions");

interface SessionRow {
	createdAt: Date;
	id: string;
	ipAddress?: string | null;
	token: string;
	userAgent?: string | null;
}

/**
 * better-auth's listSessions/revokeSession both require a *fresh* session
 * (see freshSessionMiddleware/sensitiveSessionMiddleware) : a cookie session
 * older than sessionConfig.freshAge (24h by default) gets rejected with
 * FORBIDDEN rather than an empty list. Real, not hypothetical : caught here
 * rather than left to 500, so the tab degrades to "sign in again to manage
 * sessions" instead of crashing the page.
 */
async function listSessions(headers: Headers): Promise<SessionRow[] | null> {
	try {
		const sessions = (await auth.api.listSessions({ headers })) as SessionRow[];
		return sessions;
	} catch (error) {
		logger.warn("Couldn't list sessions (likely a stale/non-fresh session)", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export const load = async ({ request, locals }) => {
	const sessions = await listSessions(request.headers);

	return {
		currentSessionId: locals.session?.id ?? null,
		sessions:
			sessions?.map((s) => ({
				createdAt: s.createdAt,
				id: s.id,
				ipAddress: s.ipAddress ?? null,
				userAgent: s.userAgent ?? null,
			})) ?? null,
	};
};

export const actions = {
	revoke: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const sessionId = (formData.get("sessionId") as string | null)?.trim();
		if (!sessionId) {
			return fail(400, { error: "Missing session id." });
		}

		// revokeSession needs the session's *token*, never sent to the client
		// (see the load function's SessionRow) : looked up again here from a
		// fresh server-side list rather than trusting anything from the form.
		const sessions = await listSessions(request.headers);
		const target = sessions?.find((s) => s.id === sessionId);
		if (!target) {
			return fail(404, { error: "Session not found." });
		}

		try {
			await auth.api.revokeSession({
				body: { token: target.token },
				headers: request.headers,
			});
		} catch (error) {
			logger.warn("Couldn't revoke session", {
				error: error instanceof Error ? error.message : String(error),
				sessionId,
			});
			return fail(400, {
				error: "Couldn't revoke that session : sign in again and retry.",
			});
		}

		logger.info(`Session revoked: session=${sessionId} user=${locals.user.id}`);
		return { success: true };
	},
};
