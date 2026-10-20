import { config } from "#lib/config.js";
import { OauthClientEnvironmentDTO } from "#lib/dto/oauth-client-environment-dto.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import {
	geminiRegistration,
	matchesCallback,
	OIDC_BASE_PATH,
	oidcTestCallback,
	tokenRequestCredentials,
} from "#lib/oidc-provider.js";

export const OIDC_TOKEN_PATH = `${OIDC_BASE_PATH}/oauth2/token`;

export const OIDC_REGISTER_PATH = `${OIDC_BASE_PATH}/oauth2/register`;

function reject(status: number, error: string, description: string): Response {
	return Response.json(
		{ error, error_description: description },
		{ headers: { "cache-control": "no-store" }, status },
	);
}

function corsHeaders(origin: string): Record<string, string> {
	return {
		"access-control-allow-headers": "authorization, content-type, dpop",
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-origin": origin,
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

/**
 * Narrows dynamic client registration to Gemini custom apps before the
 * provider sees it: a registration with any other callback is refused, and
 * an accepted one is rewritten to a public client named Gemini (see
 * `geminiRegistration`), so nothing on the internet can get itself a client
 * secret. Returns the request to hand on, or the refusal.
 */
export async function guardRegistration(
	request: Request,
): Promise<Request | Response> {
	if (request.method !== "POST") {
		return reject(405, "invalid_request", "Registration is a POST.");
	}
	const body: unknown = await request
		.clone()
		.json()
		.catch(() => null);
	const metadata = geminiRegistration(body);
	if (!metadata) {
		return reject(
			400,
			"invalid_client_metadata",
			"Only a Gemini custom app can register itself. Register any other client under IDP in Homerun's dashboard.",
		);
	}
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.set("content-type", "application/json");
	return new Request(request.url, {
		body: JSON.stringify(metadata),
		headers,
		method: "POST",
	});
}

/**
 * Enforces a client's environments on the token endpoint before the
 * provider sees the request: a code is only redeemed with a secret of the
 * environment its callback URL belongs to (so a production secret can't
 * redeem a code sent to a development localhost callback), the test
 * callback and test secrets only work from Homerun's own test sign-in, and
 * a browser call has to come from one of the environment's authorized
 * origins. Answers CORS preflights for any authorized origin. Returns the
 * refusal, or null to let the request through; a client with no
 * environments is left alone.
 */
export async function guardTokenRequest(
	request: Request,
): Promise<Response | null> {
	const origin = request.headers.get("origin");
	if (request.method === "OPTIONS") {
		if (origin && (await OauthClientEnvironmentDTO.anyAllowsOrigin(origin))) {
			return new Response(null, { headers: corsHeaders(origin), status: 204 });
		}
		return new Response(null, { status: 403 });
	}
	if (request.method !== "POST") {
		return null;
	}
	const form = new URLSearchParams(await request.clone().text());
	const { clientId, secret } = tokenRequestCredentials(
		request.headers.get("authorization"),
		form,
	);
	if (!clientId) {
		return null;
	}
	const redirectUri = form.get("redirect_uri");
	if (
		redirectUri &&
		config.auth.origin &&
		redirectUri === oidcTestCallback(config.auth.origin)
	) {
		return reject(
			400,
			"invalid_grant",
			"The test callback only works from Homerun's own test sign-in.",
		);
	}
	const environments = await OauthClientEnvironmentDTO.listForClient(clientId);
	if (environments.length === 0) {
		return null;
	}
	let environment: OauthClientEnvironmentDTO | undefined;
	if (secret) {
		const match = await OauthClientSecretDTO.match(clientId, secret);
		if (!match) {
			return null;
		}
		if (match.environmentId === null) {
			return reject(
				401,
				"invalid_client",
				"Test secrets only work from Homerun's own test sign-in.",
			);
		}
		environment = environments.find((env) => env.id === match.environmentId);
		if (
			environment &&
			form.get("grant_type") === "authorization_code" &&
			redirectUri &&
			!environment.redirectUris.some((uri) => matchesCallback(uri, redirectUri))
		) {
			return reject(
				400,
				"invalid_grant",
				`${redirectUri} isn't a callback URL of the "${environment.name}" environment this client secret belongs to.`,
			);
		}
	} else if (redirectUri) {
		environment = environments.find((env) =>
			env.redirectUris.some((uri) => matchesCallback(uri, redirectUri)),
		);
	}
	if (origin && environment && !environment.allowedOrigins.includes(origin)) {
		return reject(
			403,
			"invalid_client",
			`${origin} isn't an authorized origin of the "${environment.name}" environment.`,
		);
	}
	return null;
}

/** `response` with CORS headers added when the token request came from an authorized browser origin. */
export async function withTokenCors(
	request: Request,
	response: Response,
): Promise<Response> {
	const origin = request.headers.get("origin");
	if (!origin || !(await OauthClientEnvironmentDTO.anyAllowsOrigin(origin))) {
		return response;
	}
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(corsHeaders(origin))) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}
