export const OIDC_BASE_PATH = "/api/v1/auth";

export const OIDC_ISSUER_PATH = "/issuer";

export const OIDC_TEST_CALLBACK_PATH = "/idp/test-callback";

export const CLIENT_SECRET_MARKER = "homerun-secrets:";

export const DEFAULT_ENVIRONMENT = "production";

export const OIDC_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"groups",
] as const;

export const OIDC_CLAIMS = [
	"sub",
	"name",
	"preferred_username",
	"picture",
	"email",
	"email_verified",
	"groups",
] as const;

export interface OidcUser {
	email: string;
	emailVerified: boolean;
	image?: string | null;
	name: string;
	role?: string | null;
}

export const MCP_PATH = "/api/v1/mcp";

export const CLAUDE_MCP_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/**
 * Whether the MCP server can run on this origin: MCP clients only accept an
 * HTTPS resource, or plain HTTP on a loopback host for development. On any
 * other origin (a LAN IP over HTTP) Homerun runs without it rather than
 * failing to start its auth layer.
 */
export function mcpAllowed(origin: string): boolean {
	if (!URL.canParse(origin)) {
		return false;
	}
	const { hostname, protocol } = new URL(origin);
	if (protocol === "https:") {
		return true;
	}
	return protocol === "http:" && isLoopbackHostname(hostname);
}

/** The MCP endpoint's URL, which is also the audience its access tokens are bound to. */
export function mcpResource(origin: string): string {
	return `${origin.replace(/\/+$/, "")}${MCP_PATH}`;
}

/** The issuer Homerun signs tokens as, derived from the dashboard's origin: `<dashboard>/issuer`, whose discovery document points at the endpoints under the auth base path. */
export function oidcIssuer(origin: string): string {
	return `${origin.replace(/\/+$/, "")}${OIDC_ISSUER_PATH}`;
}

/** Where the provider's endpoints (authorize, token, userinfo, jwks) live, under the auth base path. */
export function oidcEndpointBase(origin: string): string {
	return `${origin.replace(/\/+$/, "")}${OIDC_BASE_PATH}`;
}

/** The callback the admin-only "Test sign-in" flow lands on, registered on every client and usable only by Homerun itself. */
export function oidcTestCallback(origin: string): string {
	return `${origin.replace(/\/+$/, "")}${OIDC_TEST_CALLBACK_PATH}`;
}

/** Whether a hostname is a loopback address or `localhost`. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

/**
 * Why `raw` can't be a callback URL of an environment, null when it can: it
 * has to be an absolute https URL without credentials or a fragment, and a
 * loopback one (http only) is only accepted where the environment allows
 * localhost, which is what keeps them off production.
 */
export function callbackUrlProblem(
	raw: string,
	allowLocalhost: boolean,
): string | null {
	if (!URL.canParse(raw)) {
		return "Not a full URL, e.g. https://app.example.com/auth/callback.";
	}
	const url = new URL(raw);
	if (url.hash || url.username || url.password) {
		return "Callback URLs can't carry a #fragment or credentials.";
	}
	if (isLoopbackHostname(url.hostname)) {
		if (!allowLocalhost) {
			return "Localhost callbacks are only allowed in an environment that allows localhost.";
		}
		return url.protocol === "http:"
			? null
			: "Localhost callbacks use http, e.g. http://localhost:3000/callback.";
	}
	return url.protocol === "https:" ? null : "Callback URLs have to use https.";
}

/** Why `raw` can't be an authorized origin (scheme, host and port only), null when it can. */
export function originProblem(
	raw: string,
	allowLocalhost: boolean,
): string | null {
	if (!URL.canParse(raw)) {
		return "Not an origin, e.g. https://app.example.com.";
	}
	const url = new URL(raw);
	if (url.origin === "null" || url.origin !== raw.replace(/\/+$/, "")) {
		return "An origin is only a scheme, host and port, with no path.";
	}
	if (isLoopbackHostname(url.hostname)) {
		return allowLocalhost
			? null
			: "Localhost origins are only allowed in an environment that allows localhost.";
	}
	return url.protocol === "https:" ? null : "Origins have to use https.";
}

const ENVIRONMENT_NAME = /^[\w .-]{1,32}$/;

/**
 * Why an app environment can't be saved as given, null when it can: a name
 * of up to 32 letters, digits, spaces, dots, dashes or underscores, at least
 * one callback URL, and every callback and authorized origin acceptable for
 * its localhost switch (see `callbackUrlProblem` and `originProblem`).
 */
export function environmentProblem(environment: {
	allowedOrigins: string[];
	allowLocalhost: boolean;
	name: string;
	redirectUris: string[];
}): string | null {
	if (!ENVIRONMENT_NAME.test(environment.name)) {
		return "Name the environment with up to 32 letters, digits, spaces, dots, dashes or underscores.";
	}
	if (environment.redirectUris.length === 0) {
		return "Add at least one callback URL, from the app's own OIDC settings.";
	}
	for (const uri of environment.redirectUris) {
		const problem = callbackUrlProblem(uri, environment.allowLocalhost);
		if (problem) {
			return `${uri}: ${problem}`;
		}
	}
	for (const origin of environment.allowedOrigins) {
		const problem = originProblem(origin, environment.allowLocalhost);
		if (problem) {
			return `${origin}: ${problem}`;
		}
	}
	return null;
}

/** The discovery document URL an app is pointed at to configure "Sign in with Homerun", under the issuer. */
export function oidcDiscoveryUrl(origin: string): string {
	return `${oidcIssuer(origin)}/.well-known/openid-configuration`;
}

/**
 * The profile, email and groups claims a token or the userinfo response
 * carries for `user`, limited to what `scopes` granted. `groups` holds the
 * user's Homerun role (`admin` or `developer`), which is what apps map to
 * their own admin rights. `preferred_username` falls back to the email's
 * local part, since Homerun accounts have no separate username.
 */
export function oidcClaimsFor(
	user: OidcUser,
	scopes: readonly string[],
): Record<string, unknown> {
	const claims: Record<string, unknown> = {};
	if (scopes.includes("profile")) {
		claims.name = user.name;
		claims.preferred_username = user.email.split("@")[0] ?? user.email;
		if (user.image) {
			claims.picture = user.image;
		}
	}
	if (scopes.includes("email")) {
		claims.email = user.email;
		claims.email_verified = user.emailVerified;
	}
	if (scopes.includes("groups")) {
		claims.groups = user.role ? [user.role] : [];
	}
	return claims;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
	email: "Your email address",
	groups: "Your role on this Homerun instance",
	offline_access: "Stay signed in without asking again",
	openid: "Confirm who you are",
	profile: "Your name and profile picture",
};

/** What each requested scope shares, in plain words, for the consent screen. Unknown scopes are listed by name. */
export function describeScopes(scope: string | null): string[] {
	return (scope ?? "")
		.split(" ")
		.filter(Boolean)
		.map((entry) => SCOPE_DESCRIPTIONS[entry] ?? entry);
}

/**
 * `request` with its origin swapped for the dashboard's, keeping path, query,
 * method, headers and body. better-auth builds the discovery document's
 * endpoints from the request URL, which the server adapter pins to the
 * `ORIGIN` env var (the IP the installer detected), so without this an app
 * signing in through the domain is sent to the IP.
 */
export function rebaseOnOrigin(request: Request, origin: string): Request {
	const url = new URL(request.url);
	const target = new URL(origin);
	if (url.origin === target.origin) {
		return request;
	}
	return new Request(`${target.origin}${url.pathname}${url.search}`, request);
}

/**
 * Every callback a client registers with the provider: its environments'
 * callbacks plus Homerun's own test callback when the dashboard's origin can
 * carry one (https, or loopback in development), and the application type
 * that lets loopback callbacks through (`native`), `web` otherwise.
 */
export function registeredCallbacks(
	environments: { redirectUris: string[] }[],
	origin: string | undefined,
): { applicationType: "native" | "web"; redirectUris: string[] } {
	const uris = new Set(environments.flatMap((env) => env.redirectUris));
	if (origin) {
		const test = oidcTestCallback(origin);
		if (!callbackUrlProblem(test, true)) {
			uris.add(test);
		}
	}
	const redirectUris = [...uris];
	return {
		applicationType: redirectUris.some(
			(uri) => URL.canParse(uri) && isLoopbackHostname(new URL(uri).hostname),
		)
			? "native"
			: "web",
		redirectUris,
	};
}

export interface Credentials {
	clientId: string | null;
	secret: string | null;
}

/**
 * The client id and secret a token request authenticates with: HTTP Basic
 * (form-encoded halves, RFC 6749 §2.3.1) or the `client_id`/`client_secret`
 * form fields.
 */
export function tokenRequestCredentials(
	authorization: string | null,
	form: URLSearchParams,
): Credentials {
	if (authorization?.toLowerCase().startsWith("basic ")) {
		const decoded = Buffer.from(
			authorization.slice(6).trim(),
			"base64",
		).toString();
		const separator = decoded.indexOf(":");
		if (separator > 0) {
			return {
				clientId: decodeURIComponent(
					decoded.slice(0, separator).replace(/\+/g, " "),
				),
				secret: decodeURIComponent(
					decoded.slice(separator + 1).replace(/\+/g, " "),
				),
			};
		}
	}
	return {
		clientId: form.get("client_id"),
		secret: form.get("client_secret"),
	};
}

/**
 * Whether `requested` is `registered`, or the same loopback-IP callback on
 * another port, which is the one variance the provider itself accepts
 * (RFC 8252 §7.3).
 */
export function matchesCallback(
	registered: string,
	requested: string,
): boolean {
	if (registered === requested) {
		return true;
	}
	if (!URL.canParse(registered) || !URL.canParse(requested)) {
		return false;
	}
	const reg = new URL(registered);
	const req = new URL(requested);
	return (
		reg.hostname !== "localhost" &&
		isLoopbackHostname(reg.hostname) &&
		reg.hostname === req.hostname &&
		reg.protocol === req.protocol &&
		reg.pathname === req.pathname &&
		reg.search === req.search
	);
}
