import { config } from "#lib/config.js";
import {
	type OauthClientChanges,
	OauthClientDTO,
} from "#lib/dto/oauth-client-dto.js";
import {
	type EnvironmentInput,
	OauthClientEnvironmentDTO,
} from "#lib/dto/oauth-client-environment-dto.js";
import { OauthClientSecretDTO } from "#lib/dto/oauth-client-secret-dto.js";
import {
	CLAUDE_MCP_CALLBACK,
	environmentProblem,
	mcpAllowed,
	mcpResource,
	registeredCallbacks,
} from "#lib/oidc-provider.js";

/** A change to an app Homerun refuses, with a message fit for the person or API caller who asked. */
export class OauthAppError extends Error {}

export interface OauthAppSettings {
	enableEndSession: boolean;
	name: string;
	skipConsent: boolean;
}

export type SecretAuthMethod = "client_secret_basic" | "client_secret_post";

export interface OauthAppRegistration extends OauthAppSettings {
	confidential: boolean;
	disabled?: boolean;
	requirePkce: boolean;
	tokenAuthMethod: SecretAuthMethod;
}

export interface OauthAppInput extends OauthAppRegistration {
	environment: EnvironmentInput;
}

export interface CreatedOauthApp {
	clientId: string;
	clientSecret: string | null;
}

/** An environment with its callbacks and origins de-duplicated, origins without a trailing slash. */
function normalizedEnvironment(input: EnvironmentInput): EnvironmentInput {
	return {
		...input,
		allowedOrigins: [
			...new Set(
				input.allowedOrigins.map((origin) => origin.replace(/\/+$/, "")),
			),
		],
		redirectUris: [...new Set(input.redirectUris)],
	};
}

/**
 * Registers and edits the apps allowed to use "Sign in with Homerun". Their
 * client rows are written straight to the database rather than through
 * better-auth's client endpoints, which need a session and only let the
 * admin who created a client change it: here any admin, or an API key with
 * write access to Users & authentication, can. Environments and secrets live
 * in Homerun's own tables, and the client's registered callbacks follow its
 * environments.
 */
class OauthAppServiceClass {
	/**
	 * Registers an app with no environment yet, so no callback but Homerun's
	 * own test one: nothing can sign in until an environment is added. A
	 * public app (a SPA or mobile app) has no secret and always needs PKCE,
	 * whatever `requirePkce` and `tokenAuthMethod` say. Where the MCP server
	 * runs, the app is linked to it like every client the provider registers,
	 * so it can also serve as an MCP connector.
	 */
	async register(input: OauthAppRegistration): Promise<OauthClientDTO> {
		const origin = config.auth.origin;
		const registered = registeredCallbacks([], origin);
		const app = await OauthClientDTO.create({
			applicationType: registered.applicationType,
			disabled: input.disabled ?? false,
			enableEndSession: input.enableEndSession,
			name: input.name,
			redirectUris: registered.redirectUris,
			requirePkce: input.confidential ? input.requirePkce : true,
			skipConsent: input.skipConsent,
			tokenEndpointAuthMethod: input.confidential
				? input.tokenAuthMethod
				: "none",
		});
		if (origin && mcpAllowed(origin)) {
			await app.linkResource(mcpResource(origin));
		}
		return app;
	}

	/**
	 * Registers an app with its first environment, the dashboard's
	 * registration form. A confidential app gets a client secret in that
	 * environment, returned here once and never readable again. One with
	 * Claude's connector callback sends its secret in the request body,
	 * since Claude does whatever was picked.
	 *
	 * @throws {OauthAppError} When the input is refused.
	 */
	async create(input: OauthAppInput): Promise<CreatedOauthApp> {
		const problem = environmentProblem(input.environment);
		if (problem) {
			throw new OauthAppError(problem);
		}
		const app = await this.register({
			...input,
			tokenAuthMethod: input.environment.redirectUris.includes(
				CLAUDE_MCP_CALLBACK,
			)
				? "client_secret_post"
				: input.tokenAuthMethod,
		});
		const environment = await this.addEnvironment(app, input.environment);
		if (!app.summary().confidential) {
			return { clientId: app.clientId, clientSecret: null };
		}
		const { secret } = await OauthClientSecretDTO.issue(
			app.clientId,
			environment.id,
			"Initial secret",
		);
		return { clientId: app.clientId, clientSecret: secret };
	}

	/**
	 * Saves the fields in `changes`. Whether an app is confidential is fixed
	 * at creation, so a public one takes neither a token auth method nor a
	 * PKCE exemption.
	 *
	 * @throws {OauthAppError} When a public app is asked for either.
	 */
	async update(
		app: OauthClientDTO,
		changes: OauthClientChanges,
	): Promise<void> {
		if (!app.summary().confidential) {
			if (changes.tokenEndpointAuthMethod) {
				throw new OauthAppError(
					"This app is public: it has no secret, so no token auth method.",
				);
			}
			if (changes.requirePkce === false) {
				throw new OauthAppError("A public app always requires PKCE.");
			}
		}
		await app.update(changes);
	}

	/**
	 * Adds an environment to an app and registers its callbacks.
	 *
	 * @throws {OauthAppError} When the environment is invalid or the app
	 * already has one by that name.
	 */
	async addEnvironment(
		app: OauthClientDTO,
		input: EnvironmentInput,
	): Promise<OauthClientEnvironmentDTO> {
		const normalized = normalizedEnvironment(input);
		await this.#checkEnvironment(app, normalized, null);
		const environment = await OauthClientEnvironmentDTO.create(
			app.clientId,
			normalized,
		);
		await this.syncCallbacks(app);
		return environment;
	}

	/**
	 * Saves an environment's name, callbacks, origins and localhost switch,
	 * and registers its callbacks.
	 *
	 * @throws {OauthAppError} When the environment is invalid or another of
	 * the app's environments has that name.
	 */
	async updateEnvironment(
		app: OauthClientDTO,
		environment: OauthClientEnvironmentDTO,
		input: EnvironmentInput,
	): Promise<void> {
		const normalized = normalizedEnvironment(input);
		await this.#checkEnvironment(app, normalized, environment.id);
		await environment.update(normalized);
		await this.syncCallbacks(app);
	}

	/** Deletes an environment with its secrets, and drops its callbacks. */
	async deleteEnvironment(
		app: OauthClientDTO,
		environment: OauthClientEnvironmentDTO,
	): Promise<void> {
		await environment.delete();
		await this.syncCallbacks(app);
	}

	/**
	 * Mints a secret for one of a confidential app's environments, returned
	 * here once and never readable again.
	 *
	 * @throws {OauthAppError} When the app is public or the environment isn't
	 * the app's.
	 */
	async issueSecret(
		app: OauthClientDTO,
		environmentId: string,
		label: string,
	): Promise<{
		environment: OauthClientEnvironmentDTO;
		row: OauthClientSecretDTO;
		secret: string;
	}> {
		if (!app.summary().confidential) {
			throw new OauthAppError("This app is public, so it has no secrets.");
		}
		const environment = await OauthClientEnvironmentDTO.get(
			app.clientId,
			environmentId,
		);
		if (!environment) {
			throw new OauthAppError("That environment doesn't exist any more.");
		}
		const issued = await OauthClientSecretDTO.issue(
			app.clientId,
			environment.id,
			label.trim().slice(0, 64) || "Client secret",
		);
		return { ...issued, environment };
	}

	/**
	 * Re-registers the client's callbacks from its environments (plus the
	 * test callback), after an environment changed, and the application type
	 * that lets loopback ones through.
	 */
	async syncCallbacks(app: OauthClientDTO): Promise<void> {
		const environments = await OauthClientEnvironmentDTO.listForClient(
			app.clientId,
		);
		const registered = registeredCallbacks(
			environments.map((environment) => ({
				redirectUris: environment.redirectUris,
			})),
			config.auth.origin,
		);
		await app.setCallbacks(registered.applicationType, registered.redirectUris);
	}

	/** Refuses an invalid environment, or a name another of the app's environments has. */
	async #checkEnvironment(
		app: OauthClientDTO,
		input: EnvironmentInput,
		environmentId: string | null,
	): Promise<void> {
		const problem = environmentProblem(input);
		if (problem) {
			throw new OauthAppError(problem);
		}
		const existing = await OauthClientEnvironmentDTO.listForClient(
			app.clientId,
		);
		if (
			existing.some(
				(environment) =>
					environment.id !== environmentId && environment.name === input.name,
			)
		) {
			throw new OauthAppError(`There's already a "${input.name}" environment.`);
		}
	}
}

export const OauthAppService = new OauthAppServiceClass();
