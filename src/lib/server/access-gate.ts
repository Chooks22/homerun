import { stringify } from "devalue";
import {
	APP_ONLY_HOME,
	APP_ONLY_MESSAGE,
	appOnlyMayRequest,
	can,
	hasAllPermissions,
	type Permissions,
	permissionDeniedMessage,
	requiredPermission,
} from "#lib/permissions.js";
import { SERVICE_ACCOUNT_MESSAGE } from "#lib/user-types.js";

type RefusedRequest = Pick<Request, "headers" | "method">;

/**
 * A 403 shaped for whoever sent the request: an `ActionResult` failure for a
 * `use:enhance` form (so the promise toast shows the reason), a
 * remote-function error for a command or query, JSON for the REST API, and
 * plain text otherwise.
 */
function forbidden(
	request: RefusedRequest,
	pathname: string,
	message: string,
): Response {
	const jsonHeaders = { "content-type": "application/json" };
	if (request.headers.get("x-sveltekit-action") === "true") {
		return new Response(
			JSON.stringify({
				data: stringify({ error: message }),
				status: 403,
				type: "failure",
			}),
			{ headers: jsonHeaders, status: 200 },
		);
	}
	if (pathname.startsWith("/_app/remote/")) {
		return new Response(
			JSON.stringify({
				error: { message },
				status: 403,
				type: "error",
			}),
			{ headers: jsonHeaders, status: 403 },
		);
	}
	if (pathname.startsWith("/api/")) {
		return new Response(JSON.stringify({ error: message }), {
			headers: jsonHeaders,
			status: 403,
		});
	}
	return new Response(message, { status: 403 });
}

/**
 * The 403 a caller gets for a request its permissions don't cover, from the
 * area owning the matched route (see `requiredPermission`). Page reads are
 * left to the `(protected)` layout, which renders the refusal as an error
 * page instead; an endpoint (`isEndpoint`, a `+server.ts` route) never runs
 * that layout, so its reads are refused here.
 *
 * @returns Null when the request is allowed.
 */
export function permissionRejection(
	request: RefusedRequest,
	pathname: string,
	route: { id: string | null; isEndpoint: boolean },
	permissions: Permissions,
): Response | null {
	const required = requiredPermission(request.method, route.id);
	if (!required) {
		return null;
	}
	if (required === "unmapped") {
		return hasAllPermissions(permissions)
			? null
			: forbidden(request, pathname, "Admins only.");
	}
	if (can(permissions, required.area, required.level)) {
		return null;
	}
	if (required.level === "read" && !route.isEndpoint) {
		return null;
	}
	return forbidden(
		request,
		pathname,
		permissionDeniedMessage(required.area, required.level),
	);
}

/**
 * What an app-access-only user gets for anything outside `appOnlyMayRequest`:
 * a page navigation is sent to their apps page (a `__data.json` request gets
 * SvelteKit's own JSON redirect so client-side navigation follows it), and
 * every other request a 403 shaped like `permissionRejection`'s.
 *
 * @returns Null when the request is allowed.
 */
export function appOnlyRejection(
	request: RefusedRequest,
	pathname: string,
	routeId: string | null,
	isDataRequest: boolean,
): Response | null {
	if (appOnlyMayRequest(pathname, routeId)) {
		return null;
	}
	const isPageRead =
		(request.method === "GET" || request.method === "HEAD") &&
		!pathname.startsWith("/api/") &&
		!pathname.startsWith("/_app/");
	if (isPageRead && isDataRequest) {
		return new Response(
			JSON.stringify({ location: APP_ONLY_HOME, type: "redirect" }),
			{ headers: { "content-type": "application/json" } },
		);
	}
	if (isPageRead) {
		return new Response(null, {
			headers: { location: APP_ONLY_HOME },
			status: 303,
		});
	}
	return forbidden(request, pathname, APP_ONLY_MESSAGE);
}

/**
 * What a service account's key may reach: `/app-auth`, where it trades the key
 * for a login-wall grant, and only the routes owned by an area it was granted.
 * Every route open to any signed-in user (the overview, profile, MCP,
 * notifications…) is refused, as is anything outside the dashboard and the
 * REST API. The level is left to `permissionRejection`.
 *
 * @returns Null when the request is allowed.
 */
export function serviceAccountRejection(
	request: RefusedRequest,
	pathname: string,
	routeId: string | null,
	permissions: Permissions,
): Response | null {
	if (routeId === "/app-auth") {
		return null;
	}
	const required = requiredPermission(request.method, routeId);
	const granted =
		required === "unmapped"
			? hasAllPermissions(permissions)
			: required !== null && can(permissions, required.area);
	return granted ? null : forbidden(request, pathname, SERVICE_ACCOUNT_MESSAGE);
}
