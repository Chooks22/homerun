import type { EnvironmentInput } from "#lib/dto/oauth-client-environment-dto.js";
import { environmentProblem } from "#lib/oidc-provider.js";
import { checkbox } from "#lib/server/validation/instance-settings-form.js";
import type {
	OauthAppInput,
	OauthAppSettings,
	SecretAuthMethod,
} from "#lib/services/oauth-app.service.js";

type Parsed<T> = { error: string; input: null } | { error: null; input: T };

/** The non-empty, trimmed, de-duplicated values of a repeated form field. */
function list(formData: FormData, name: string): string[] {
	return [
		...new Set(
			formData
				.getAll(name)
				.map((value) => String(value).trim())
				.filter(Boolean),
		),
	];
}

/**
 * Reads the app-wide settings: a name, the consent, logout and PKCE options
 * and how the secret is sent. `requirePkce` and `tokenAuthMethod` only mean
 * something for a confidential app.
 */
export function parseOauthAppSettings(
	formData: FormData,
): Parsed<
	OauthAppSettings & { requirePkce: boolean; tokenAuthMethod: SecretAuthMethod }
> {
	const name = String(formData.get("name") ?? "").trim();
	if (!name) {
		return { error: "Give the app a name.", input: null };
	}
	return {
		error: null,
		input: {
			enableEndSession: checkbox(formData, "enableEndSession"),
			name,
			requirePkce: checkbox(formData, "requirePkce"),
			skipConsent: checkbox(formData, "skipConsent"),
			tokenAuthMethod:
				formData.get("tokenAuthMethod") === "client_secret_post"
					? "client_secret_post"
					: "client_secret_basic",
		},
	};
}

/**
 * Reads an environment: its name, localhost switch, callback URLs and
 * authorized origins, de-duplicated and normalized without a trailing slash,
 * then checked by `environmentProblem`.
 */
export function parseEnvironmentForm(
	formData: FormData,
): Parsed<EnvironmentInput> {
	const input: EnvironmentInput = {
		allowedOrigins: [
			...new Set(
				list(formData, "allowedOrigins").map((origin) =>
					origin.replace(/\/+$/, ""),
				),
			),
		],
		allowLocalhost: checkbox(formData, "allowLocalhost"),
		name: String(formData.get("environmentName") ?? "").trim(),
		redirectUris: list(formData, "redirectUris"),
	};
	const problem = environmentProblem(input);
	return problem ? { error: problem, input: null } : { error: null, input };
}

/** Reads the registration form: the app's settings, its client type and its first environment. */
export function parseOauthAppForm(formData: FormData): Parsed<OauthAppInput> {
	const settings = parseOauthAppSettings(formData);
	if (!settings.input) {
		return settings;
	}
	const environment = parseEnvironmentForm(formData);
	if (!environment.input) {
		return environment;
	}
	return {
		error: null,
		input: {
			...settings.input,
			confidential: formData.get("clientType") !== "public",
			environment: environment.input,
		},
	};
}
