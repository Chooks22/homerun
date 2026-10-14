import { generateRandomString } from "better-auth/crypto";
import { desc, eq } from "drizzle-orm";
import {
	CLIENT_SECRET_MARKER,
	OIDC_SCOPES,
	OIDC_TEST_CALLBACK_PATH,
} from "#lib/oidc-provider.js";
import { db } from "#lib/server/db/lib.js";
import {
	type OauthClient,
	oauthClient,
	oauthClientResource,
	oauthResource,
} from "#lib/server/db/schema.js";
import { BaseDTO } from "./base-dto";

/** A string-array column the auth adapter stores as JSON text, read back as a list. */
function jsonList(value: string | null): string[] {
	if (!value) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

export type TokenEndpointAuthMethod =
	| "client_secret_basic"
	| "client_secret_post"
	| "none";

export interface NewOauthClient {
	applicationType: "native" | "web";
	disabled: boolean;
	enableEndSession: boolean;
	name: string;
	redirectUris: string[];
	requirePkce: boolean;
	skipConsent: boolean;
	tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

export interface OauthClientChanges {
	disabled?: boolean;
	enableEndSession?: boolean;
	name?: string;
	requirePkce?: boolean;
	skipConsent?: boolean;
	tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
}

export interface OauthClientSummary {
	clientId: string;
	confidential: boolean;
	createdAt: Date | null;
	disabled: boolean;
	enableEndSession: boolean;
	id: string;
	name: string;
	redirectUris: string[];
	requirePkce: boolean;
	scopes: string[];
	skipConsent: boolean;
	tokenAuthMethod: string;
}

/**
 * Wraps the `oauth_client` table: the apps registered to use "Sign in with
 * Homerun". Written here rather than through better-auth's client endpoints,
 * which need a session and only let the admin who created a client change
 * it; `OauthAppService` validates the input first.
 */
export class OauthClientDTO extends BaseDTO<OauthClient> {
	/** Every registered app, newest first. */
	static async list(): Promise<OauthClientDTO[]> {
		const rows = await db
			.select()
			.from(oauthClient)
			.orderBy(desc(oauthClient.createdAt));
		return rows.map((row) => new OauthClientDTO(row));
	}

	/** The registered app with this row id, null when there's none. */
	static async get(id: string): Promise<OauthClientDTO | null> {
		const [row] = await db
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.id, id))
			.limit(1);
		return row ? new OauthClientDTO(row) : null;
	}

	/** The registered app with this public client id, null when there's none. */
	static async getByClientId(clientId: string): Promise<OauthClientDTO | null> {
		const [row] = await db
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.clientId, clientId))
			.limit(1);
		return row ? new OauthClientDTO(row) : null;
	}

	/**
	 * Inserts an app's client row the way better-auth's provider registers
	 * one (list columns as JSON text, the id it signs in with), owned by no
	 * user, so any admin or API key with the right permission can manage it.
	 * A confidential app's `client_secret` points at the
	 * `oauth_client_secret` table (`homerun-secrets:<client id>`), which
	 * `OauthClientSecretDTO.verify` reads; a public one has none.
	 */
	static async create(input: NewOauthClient): Promise<OauthClientDTO> {
		const clientId = generateRandomString(32, "a-z", "A-Z");
		const now = new Date();
		const row: OauthClient = {
			applicationType: input.applicationType,
			backchannelLogoutSessionRequired: null,
			backchannelLogoutUri: null,
			clientCredentialsScopes: "[]",
			clientDiscoveryId: null,
			clientId,
			clientSecret:
				input.tokenEndpointAuthMethod === "none"
					? null
					: `${CLIENT_SECRET_MARKER}${clientId}`,
			contacts: null,
			createdAt: now,
			disabled: input.disabled,
			dpopBoundAccessTokens: false,
			enableEndSession: input.enableEndSession,
			grantTypes: JSON.stringify(["authorization_code", "refresh_token"]),
			icon: null,
			id: crypto.randomUUID(),
			jwks: null,
			jwksUri: null,
			metadata: null,
			name: input.name,
			policy: null,
			postLogoutRedirectUris: null,
			redirectUris: JSON.stringify(input.redirectUris),
			referenceId: null,
			requirePKCE: input.requirePkce,
			responseTypes: JSON.stringify(["code"]),
			scopes: JSON.stringify([...OIDC_SCOPES]),
			skipConsent: input.skipConsent,
			softwareId: null,
			softwareStatement: null,
			softwareVersion: null,
			subjectType: null,
			tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
			tos: null,
			updatedAt: now,
			uri: null,
			userId: null,
		};
		await db.insert(oauthClient).values(row);
		return new OauthClientDTO(row);
	}

	/**
	 * Links the app to a protected resource (the MCP endpoint), as
	 * better-auth's provider does for every client it registers, so its
	 * tokens may carry that audience: the provider refuses a resource a
	 * client isn't linked to. Seeds the resource row first when the provider
	 * hasn't yet, the way it would.
	 */
	async linkResource(identifier: string): Promise<void> {
		const now = new Date();
		await db
			.insert(oauthResource)
			.values({
				createdAt: now,
				disabled: false,
				dpopBoundAccessTokensRequired: false,
				id: generateRandomString(32, "a-z", "A-Z"),
				identifier,
				name: identifier,
				policyVersion: 1,
				updatedAt: now,
			})
			.onConflictDoNothing({ target: oauthResource.identifier });
		await db
			.insert(oauthClientResource)
			.values({
				clientId: this.row.clientId,
				createdAt: now,
				id: generateRandomString(32, "a-z", "A-Z"),
				resourceId: identifier,
			})
			.onConflictDoNothing();
	}

	/**
	 * Saves the fields in `changes`. `tokenEndpointAuthMethod` only switches a
	 * confidential app between `client_secret_basic` and `client_secret_post`;
	 * whether an app is public is fixed at creation.
	 */
	async update(changes: OauthClientChanges): Promise<void> {
		const set: Partial<OauthClient> = {
			disabled: changes.disabled,
			enableEndSession: changes.enableEndSession,
			name: changes.name,
			requirePKCE: changes.requirePkce,
			skipConsent: changes.skipConsent,
			tokenEndpointAuthMethod: changes.tokenEndpointAuthMethod,
		};
		const defined = Object.fromEntries(
			Object.entries(set).filter(([, value]) => value !== undefined),
		) as Partial<OauthClient>;
		if (Object.keys(defined).length === 0) {
			return;
		}
		const updatedAt = new Date();
		await db
			.update(oauthClient)
			.set({ ...defined, updatedAt })
			.where(eq(oauthClient.id, this.row.id));
		Object.assign(this.row, defined, { updatedAt });
	}

	/**
	 * Registers the callbacks codes may be sent to, and the application type
	 * that lets loopback ones through (`native`), with the provider.
	 */
	async setCallbacks(
		applicationType: "native" | "web",
		redirectUris: string[],
	): Promise<void> {
		const updatedAt = new Date();
		const redirectUrisJson = JSON.stringify(redirectUris);
		await db
			.update(oauthClient)
			.set({ applicationType, redirectUris: redirectUrisJson, updatedAt })
			.where(eq(oauthClient.id, this.row.id));
		Object.assign(this.row, {
			applicationType,
			redirectUris: redirectUrisJson,
			updatedAt,
		});
	}

	/**
	 * Deletes the app. Its tokens and consents cascade with it, so anyone
	 * signed in to it through Homerun loses access at their next token use.
	 */
	async delete(): Promise<void> {
		await db.delete(oauthClient).where(eq(oauthClient.id, this.row.id));
	}

	/** The row id. */
	get id(): string {
		return this.row.id;
	}

	/** The public client id apps are configured with. */
	get clientId(): string {
		return this.row.clientId;
	}

	/** The app's display name, falling back to its client id. */
	get name(): string {
		return this.row.name || this.row.clientId;
	}

	/** How the app authenticates at the token endpoint: `client_secret_basic`, `client_secret_post` or `none`. */
	get tokenEndpointAuthMethod(): string {
		return this.row.tokenEndpointAuthMethod ?? "client_secret_basic";
	}

	/** The plain, serializable view the admin pages render. */
	summary(): OauthClientSummary {
		return {
			clientId: this.row.clientId,
			confidential: this.row.tokenEndpointAuthMethod !== "none",
			createdAt: this.row.createdAt,
			disabled: this.row.disabled ?? false,
			enableEndSession: this.row.enableEndSession ?? false,
			id: this.row.id,
			name: this.name,
			redirectUris: jsonList(this.row.redirectUris).filter(
				(uri) => !uri.endsWith(OIDC_TEST_CALLBACK_PATH),
			),
			requirePkce: this.row.requirePKCE ?? true,
			scopes: jsonList(this.row.scopes),
			skipConsent: this.row.skipConsent ?? false,
			tokenAuthMethod: this.tokenEndpointAuthMethod,
		};
	}
}
