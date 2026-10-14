import type { OauthProviderInput } from "#lib/dto/instance-settings-dto.js";
import type { OauthTokenAuthMethod } from "#lib/server/db/schema.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const RESERVED_NAMES = new Set(["apps", "new", "protected", "providers"]);

export interface ParsedOauthProvider {
	error: string | null;
	input: OauthProviderInput | null;
}

interface DiscoveryResult {
	error: string | null;
	tokenAuthMethods: string[];
}

function parseTokenAuthMethod(raw: string | null): OauthTokenAuthMethod {
	return raw === "basic" || raw === "post" ? raw : "auto";
}

/**
 * Fetches an OpenID discovery document (5 second timeout) to check it is real
 * and read which token endpoint auth methods it advertises.
 *
 * @returns An error message when it can't be reached or has no issuer,
 * otherwise the advertised methods.
 */
async function inspectDiscoveryUrl(url: string): Promise<DiscoveryResult> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) {
			return { error: `Returned HTTP ${res.status}.`, tokenAuthMethods: [] };
		}
		const body = (await res.json().catch(() => null)) as {
			issuer?: string;
			token_endpoint_auth_methods_supported?: unknown;
		} | null;
		if (!body?.issuer) {
			return {
				error:
					'Didn\'t return a valid OpenID discovery document (missing "issuer").',
				tokenAuthMethods: [],
			};
		}
		const advertised = body.token_endpoint_auth_methods_supported;
		return {
			error: null,
			tokenAuthMethods: Array.isArray(advertised)
				? advertised.filter((m): m is string => typeof m === "string")
				: [],
		};
	} catch (error) {
		return {
			error:
				error instanceof Error
					? `Couldn't be reached: ${error.message}`
					: "Couldn't be reached.",
			tokenAuthMethods: [],
		};
	}
}

function text(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === "string" ? value.trim() : "";
}

export interface OauthProviderFields {
	clientId: string;
	clientSecret?: string;
	discoveryUrl: string;
	enabled: boolean;
	label: string;
	name: string;
	pkce: boolean;
	scopes: string[];
	signOutOfProvider: boolean;
	tokenAuthMethod: OauthTokenAuthMethod;
}

/**
 * Validates an OAuth provider, from the dashboard form or the REST API: the
 * id must be a lowercase slug not in `takenNames`, client id and discovery
 * URL are required, and the discovery URL is fetched live to confirm it
 * works (a provider that can't be discovered locks every sign-in out). A
 * blank label falls back to the id, and a blank client secret is left
 * undefined so an edit keeps the stored one.
 *
 * @returns The provider input, or the first validation error.
 */
export async function checkOauthProvider(
	fields: OauthProviderFields,
	takenNames: string[],
): Promise<ParsedOauthProvider> {
	const name = fields.name.trim().toLowerCase();
	const clientId = fields.clientId.trim();
	const discoveryUrl = fields.discoveryUrl.trim();

	if (!name) {
		return { error: "Give the provider an id.", input: null };
	}
	if (!NAME_RE.test(name)) {
		return {
			error:
				'The provider id can only contain lowercase letters, digits and hyphens, and must start with a letter or digit : it appears in the redirect URI (for example "pocket-id").',
			input: null,
		};
	}
	if (RESERVED_NAMES.has(name)) {
		return {
			error: `"${name}" is taken by an Authentication page, pick another id.`,
			input: null,
		};
	}
	if (takenNames.includes(name)) {
		return {
			error: `Another provider already uses the id "${name}".`,
			input: null,
		};
	}
	if (!clientId) {
		return { error: "The client id is required.", input: null };
	}
	if (!discoveryUrl) {
		return { error: "The discovery URL is required.", input: null };
	}

	const discovery = await inspectDiscoveryUrl(discoveryUrl);
	if (discovery.error) {
		return {
			error: `That discovery URL is invalid: ${discovery.error}`,
			input: null,
		};
	}

	return {
		error: null,
		input: {
			clientId,
			clientSecret: fields.clientSecret?.trim() || undefined,
			discoveredTokenAuth: discovery.tokenAuthMethods,
			discoveryUrl,
			enabled: fields.enabled,
			label: fields.label.trim() || name,
			name,
			pkce: fields.pkce,
			scopes: fields.scopes.map((scope) => scope.trim()).filter(Boolean),
			signOutOfProvider: fields.signOutOfProvider,
			tokenAuthMethod: fields.tokenAuthMethod,
		},
	};
}

/** The OAuth provider fields of a submitted Authentication form, for `checkOauthProvider`. */
export function readOauthProviderForm(formData: FormData): OauthProviderFields {
	return {
		clientId: text(formData, "clientId"),
		clientSecret: text(formData, "clientSecret"),
		discoveryUrl: text(formData, "discoveryUrl"),
		enabled: formData.get("enabled") === "on",
		label: text(formData, "label"),
		name: text(formData, "name"),
		pkce: formData.get("pkce") === "on",
		scopes: text(formData, "scopes").split(","),
		signOutOfProvider: formData.get("signOutOfProvider") === "on",
		tokenAuthMethod: parseTokenAuthMethod(
			formData.get("tokenAuthMethod") as string | null,
		),
	};
}
