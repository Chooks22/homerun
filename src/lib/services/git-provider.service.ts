import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "#lib/config.js";
import type { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import {
	createWebhookRequest,
	deleteWebhookPath,
	existingWebhookId,
	openPullRequestsPath,
	type PullRequestEvent,
	parseOpenPullRequests,
	type WebhookRequest,
	webhookIdFrom,
} from "#lib/git-webhooks.js";
import { Logger } from "#lib/logger.js";
import type { GitProviderConfig } from "#lib/server/db/schema.js";
import { providerApiBase } from "#lib/status-checks.js";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

const logger = new Logger("GitProvider");

/** The configured, enabled git provider with this id, null otherwise. */
export async function enabledGitProvider(
	providerId: string | null,
): Promise<GitProviderConfig | null> {
	if (!providerId) {
		return null;
	}
	const settings = await InstanceSettingsDTO.get();
	return (
		settings.gitProviders.find((p) => p.id === providerId && p.enabled) ?? null
	);
}

export interface GitRepo {
	cloneUrl: string;
	defaultBranch: string;
	fullName: string;
	private: boolean;
}

export interface ExchangedToken {
	accessToken: string;
	expiresAt: Date | null;
	providerUsername: string;
	refreshToken: string | null;
}

/** The raw token-endpoint result, before it's turned into an ExchangedToken. */
interface TokenGrant {
	accessToken: string;
	expiresIn: number | null;
	refreshToken: string | null;
}

/**
 * A provider refused an API call with 401 or 403. `reconnectHelps` is true
 * when the refusal is about the token itself (revoked, expired, or granted
 * before Homerun asked for the scope the call needs), false when it's about
 * the account's rights on the repository or the provider's own settings.
 */
export class GitProviderRefusedError extends Error {
	override name = "GitProviderRefusedError";
	readonly reconnectHelps: boolean;
	readonly status: number;

	/**
	 * @param status The HTTP status the provider answered with.
	 * @param reconnectHelps Whether reconnecting the provider would fix it.
	 */
	constructor(message: string, status: number, reconnectHelps: boolean) {
		super(message);
		this.status = status;
		this.reconnectHelps = reconnectHelps;
	}
}

const TOKEN_REFUSAL_PATTERN =
	/scope|token|unauthori[sz]ed|expired|revoked|invalid[_ ]grant|credential/i;

const STALE_GRANT_PATTERN = /token scope=/i;

const APP_PERMISSION_PATTERN = /not accessible by integration/i;

/** The human-readable reason in a provider's error body, whichever of the common shapes it uses. */
function providerErrorDetail(bodyText: string): string {
	try {
		const body = JSON.parse(bodyText) as {
			error?: string | { message?: string };
			error_description?: string;
			message?: string;
		};
		const detail =
			body.message ??
			body.error_description ??
			(typeof body.error === "string" ? body.error : body.error?.message);
		return (detail ?? "").trim();
	} catch {
		return bodyText.trim().slice(0, 300);
	}
}

/**
 * Turns a provider's 401/403 answer into a refusal error: carries the
 * provider's own reason, and only suggests reconnecting when that reason is
 * about the token (always for a 401). A GitHub App missing a permission says
 * which ones to add, since reconnecting can't grant them. Gitea's scope mismatch says to revoke
 * the app first: Gitea reuses an existing authorization on reconnect, scopes
 * included, so reconnecting alone hands back the same token scopes.
 */
export function refusalFrom(
	providerName: string,
	status: number,
	bodyText: string,
): GitProviderRefusedError {
	const detail = providerErrorDetail(bodyText);
	const reconnectHelps =
		status === 401 || detail === "" || TOKEN_REFUSAL_PATTERN.test(detail);
	const reason = detail ? `: ${detail}` : "";
	const advice = APP_PERMISSION_PATTERN.test(detail)
		? `The ${providerName} app is missing a permission this needs, and reconnecting won't add it: in the app's settings on GitHub, under Permissions, give it Read and write on Pull requests and on Deployments, save, then accept the new permissions on its installation (Settings → Applications → Installed GitHub Apps → Configure).`
		: STALE_GRANT_PATTERN.test(detail)
			? `Its authorization for Homerun predates the permissions Homerun now asks for, and reconnecting reuses it: revoke Homerun in ${providerName}'s settings (Gitea: Settings → Applications → Authorized OAuth2 Applications), then reconnect.`
			: reconnectHelps
				? "Reconnect it so Homerun gets repository and webhook access."
				: "Reconnecting won't change this: the connected account needs admin rights on the repository, or the provider has webhooks turned off.";
	return new GitProviderRefusedError(
		`${providerName} refused the request (${status})${reason}. ${advice}`,
		status,
		reconnectHelps,
	);
}

interface ProviderEndpoints {
	api: string;
	authorize: string;
	scope: string;
	token: string;
}

/**
 * Resolves the OAuth authorize/token/API base URLs and scope string for one
 * provider kind. Gitea has no public default instance, so a Gitea provider
 * with no `baseUrl` throws.
 *
 * @throws For a Gitea provider with no `baseUrl`, or an unknown provider kind.
 */
function endpoints(provider: GitProviderConfig): ProviderEndpoints {
	const base = provider.baseUrl?.replace(/\/+$/, "") || null;
	switch (provider.kind) {
		case "github":
			return {
				api: providerApiBase("github", null),
				authorize: "https://github.com/login/oauth/authorize",
				scope: "repo read:user",
				token: "https://github.com/login/oauth/access_token",
			};
		case "gitlab": {
			const b = base ?? "https://gitlab.com";
			return {
				api: providerApiBase("gitlab", b),
				authorize: `${b}/oauth/authorize`,
				scope: "api read_user",
				token: `${b}/oauth/token`,
			};
		}
		case "gitea": {
			// Self-hosted only : there's no public gitea.com instance to
			// default to, unlike the other three.
			if (!base) {
				throw new Error("Gitea providers require a base URL.");
			}
			return {
				api: providerApiBase("gitea", base),
				authorize: `${base}/login/oauth/authorize`,
				scope: "write:repository read:user",
				token: `${base}/login/oauth/access_token`,
			};
		}
		case "bitbucket":
			return {
				api: providerApiBase("bitbucket", null),
				authorize: "https://bitbucket.org/site/oauth2/authorize",
				scope: "repository webhook account",
				token: "https://bitbucket.org/site/oauth2/access_token",
			};
		default: {
			const exhaustive: never = provider.kind;
			throw new Error(`Unknown git provider kind: ${exhaustive}`);
		}
	}
}

/** When a token granted `expiresIn` seconds from now expires, null when the provider gave no lifetime. */
function expiryFrom(expiresIn: number | null): Date | null {
	return expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
}

function authHeader(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

/**
 * OAuth App client for git-hosting providers (GitHub/GitLab/Gitea/
 * Bitbucket) : lets a user connect their own account (see the Git
 * Providers page for the instance-wide OAuth App config each of these
 * needs registered on the provider's own site first) so the Source tab can
 * browse their repos and check for a Dockerfile instead of pasting a raw
 * (possibly token-embedded) URL. One standard OAuth2 authorization-code
 * flow per provider, differing mainly in endpoint URLs/request shapes :
 * see `endpoints()` above for exactly what differs.
 *
 * Not live-tested against a real registered OAuth App on each provider
 * (that requires the admin to actually register one on GitHub/GitLab/
 * Gitea/Bitbucket's own site first, with a real callback URL : nothing
 * this session could do on its own, unlike everything else built this
 * session). Built carefully from each provider's own standard, well-
 * documented OAuth2 + REST API shapes; verify the first real connect end
 * to end once an OAuth App is registered.
 */
class GitProviderServiceClass {
	readonly #refreshing = new Map<string, Promise<string | null>>();

	/**
	 * Signed, stateless CSRF state param for the OAuth redirect round-trip :
	 * no server-side storage/cleanup needed (unlike a DB-backed state
	 * table), verified purely from the value itself plus config.auth.secret.
	 */
	createState(providerId: string, userId: string): string {
		const nonce = randomBytes(8).toString("hex");
		const payload = `${providerId}:${userId}:${nonce}:${Date.now()}`;
		const sig = createHmac("sha256", config.auth.secret)
			.update(payload)
			.digest("hex");
		return Buffer.from(`${payload}:${sig}`).toString("base64url");
	}

	/**
	 * Verifies a state param produced by `createState`: checks its HMAC
	 * signature, that it was minted for this `providerId`/`userId` pair, and
	 * that it's no older than `STATE_MAX_AGE_MS`. Never throws; a malformed
	 * or tampered state simply fails verification.
	 */
	verifyState(state: string, providerId: string, userId: string): boolean {
		try {
			const decoded = Buffer.from(state, "base64url").toString("utf8");
			const parts = decoded.split(":");
			const sig = parts.pop();
			const [pid, uid, , tsStr] = parts;
			if (!sig || pid !== providerId || uid !== userId) {
				return false;
			}
			const payload = parts.join(":");
			const expected = createHmac("sha256", config.auth.secret)
				.update(payload)
				.digest("hex");
			const sigBuf = Buffer.from(sig, "hex");
			const expectedBuf = Buffer.from(expected, "hex");
			if (
				sigBuf.length !== expectedBuf.length ||
				!timingSafeEqual(sigBuf, expectedBuf)
			) {
				return false;
			}
			const ts = Number(tsStr);
			return !!ts && Date.now() - ts <= STATE_MAX_AGE_MS;
		} catch {
			return false;
		}
	}

	/** URL to send the browser to, kicking off the provider's own consent screen. */
	authorizeUrl(
		provider: GitProviderConfig,
		state: string,
		redirectUri: string,
	): string {
		const { authorize, scope } = endpoints(provider);
		const url = new URL(authorize);
		url.searchParams.set("client_id", provider.clientId);
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", scope);
		url.searchParams.set("state", state);
		return url.toString();
	}

	/** Exchanges the callback's `code` for an access (+ refresh) token, then fetches the connected account's own username. */
	async exchangeCode(
		provider: GitProviderConfig,
		code: string,
		redirectUri: string,
	): Promise<ExchangedToken> {
		const grant = await this.#requestToken(provider, {
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		});

		const providerUsername = await this.fetchUsername(
			provider,
			grant.accessToken,
		);

		return {
			accessToken: grant.accessToken,
			expiresAt: expiryFrom(grant.expiresIn),
			providerUsername,
			refreshToken: grant.refreshToken,
		};
	}

	/**
	 * The connection's access token, refreshed first when it has expired (or
	 * is about to) and a refresh token is stored. Gitea, GitLab, Bitbucket and
	 * GitHub Apps all issue short-lived tokens, so without this a connection
	 * silently stops working an hour or so after it was authorized. The
	 * refreshed tokens are persisted onto the connection. Concurrent callers
	 * for the same connection share one refresh, since providers that rotate
	 * refresh tokens reject the second use of the old one.
	 *
	 * @returns The usable access token, the stale one when the refresh fails
	 * (the caller's API call then reports the failure), or null when the
	 * stored token can't be decrypted.
	 */
	async accessToken(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
	): Promise<string | null> {
		const current = decryptSecret(connection.accessTokenEnc);
		const expiresAt = connection.expiresAt;
		if (
			!(expiresAt && connection.refreshTokenEnc) ||
			expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS > Date.now()
		) {
			return current;
		}

		const pending = this.#refreshing.get(connection.id);
		if (pending) {
			return await pending;
		}
		const refresh = this.#refresh(provider, connection)
			.catch((err) => {
				logger.warn(
					`Token refresh failed: provider=${provider.id} connection=${connection.id}`,
					err,
				);
				return current;
			})
			.finally(() => this.#refreshing.delete(connection.id));
		this.#refreshing.set(connection.id, refresh);
		return await refresh;
	}

	/**
	 * Trades the connection's refresh token for a new access token and writes
	 * both (plus the new expiry) back onto the connection row.
	 *
	 * @throws When the stored refresh token can't be decrypted or the
	 * provider rejects the refresh.
	 */
	async #refresh(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
	): Promise<string> {
		const refreshToken = connection.refreshTokenEnc
			? decryptSecret(connection.refreshTokenEnc)
			: null;
		if (!refreshToken) {
			throw new Error("Couldn't decrypt the stored refresh token.");
		}

		const params: Record<string, string> = {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		};
		if (config.auth.origin) {
			params.redirect_uri = `${config.auth.origin.replace(/\/+$/, "")}/api/v1/git-providers/${provider.id}/callback`;
		}
		const grant = await this.#requestToken(provider, params);

		await connection.update({
			accessTokenEnc: encryptSecret(grant.accessToken),
			expiresAt: expiryFrom(grant.expiresIn),
			refreshTokenEnc: grant.refreshToken
				? encryptSecret(grant.refreshToken)
				: connection.refreshTokenEnc,
		});
		logger.info(
			`Git provider token refreshed: provider=${provider.id} connection=${connection.id}`,
		);
		return grant.accessToken;
	}

	/**
	 * POSTs a grant (authorization code or refresh token) to the provider's
	 * token endpoint. Bitbucket authenticates the client with HTTP Basic and
	 * takes no redirect URI; every other provider takes the client
	 * credentials as body params.
	 *
	 * @throws When the endpoint responds with an error or no access token.
	 */
	async #requestToken(
		provider: GitProviderConfig,
		grant: Record<string, string>,
	): Promise<TokenGrant> {
		const { token: tokenUrl } = endpoints(provider);
		const clientSecret = decryptSecret(provider.clientSecretEnc) ?? "";
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		};
		const params = new URLSearchParams(grant);
		if (provider.kind === "bitbucket") {
			params.delete("redirect_uri");
			headers.Authorization = `Basic ${Buffer.from(
				`${provider.clientId}:${clientSecret}`,
			).toString("base64")}`;
		} else {
			params.set("client_id", provider.clientId);
			params.set("client_secret", clientSecret);
		}

		const res = await fetch(tokenUrl, {
			body: params,
			headers,
			method: "POST",
		});
		if (!res.ok) {
			throw new Error(
				`Token exchange failed: ${res.status} ${await res.text()}`,
			);
		}
		const body = (await res.json()) as {
			access_token?: string;
			error?: string;
			error_description?: string;
			expires_in?: number;
			refresh_token?: string;
		};
		if (!body.access_token) {
			throw new Error(
				`Token exchange failed: ${body.error ?? "no access_token"} ${body.error_description ?? ""}`,
			);
		}
		return {
			accessToken: body.access_token,
			expiresIn: body.expires_in ?? null,
			refreshToken: body.refresh_token ?? null,
		};
	}

	/**
	 * Fetches the connected account's own username from the provider's API,
	 * used to label the stored connection.
	 *
	 * @throws When the provider's `/user` endpoint doesn't respond ok.
	 */
	private async fetchUsername(
		provider: GitProviderConfig,
		accessToken: string,
	): Promise<string> {
		const { api } = endpoints(provider);
		const res = await fetch(`${api}/user`, {
			headers: authHeader(accessToken),
		});
		if (!res.ok) {
			throw new Error(`Couldn't fetch account info: ${res.status}`);
		}
		const body = (await res.json()) as {
			login?: string;
			username?: string;
		};
		return body.login ?? body.username ?? "unknown";
	}

	/** Lists repos the connected account is a member of, normalized across providers. */
	async listRepos(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
	): Promise<GitRepo[]> {
		const { api } = endpoints(provider);
		const accessToken = await this.accessToken(provider, connection);
		if (!accessToken) {
			throw new Error("Couldn't decrypt the stored access token.");
		}
		const headers = authHeader(accessToken);

		switch (provider.kind) {
			case "github": {
				const res = await fetch(`${api}/user/repos?per_page=100&sort=updated`, {
					headers,
				});
				if (!res.ok) {
					throw new Error(`Couldn't list repos: ${res.status}`);
				}
				const body = (await res.json()) as Array<{
					clone_url: string;
					default_branch: string;
					full_name: string;
					private: boolean;
				}>;
				return body.map((r) => ({
					cloneUrl: r.clone_url,
					defaultBranch: r.default_branch,
					fullName: r.full_name,
					private: r.private,
				}));
			}
			case "gitlab": {
				const res = await fetch(
					`${api}/projects?membership=true&per_page=100`,
					{ headers },
				);
				if (!res.ok) {
					throw new Error(`Couldn't list repos: ${res.status}`);
				}
				const body = (await res.json()) as Array<{
					default_branch: string;
					http_url_to_repo: string;
					path_with_namespace: string;
					visibility: string;
				}>;
				return body.map((r) => ({
					cloneUrl: r.http_url_to_repo,
					defaultBranch: r.default_branch,
					fullName: r.path_with_namespace,
					private: r.visibility !== "public",
				}));
			}
			case "gitea": {
				const res = await fetch(`${api}/user/repos?limit=50`, { headers });
				if (!res.ok) {
					throw new Error(`Couldn't list repos: ${res.status}`);
				}
				const body = (await res.json()) as Array<{
					clone_url: string;
					default_branch: string;
					full_name: string;
					private: boolean;
				}>;
				return body.map((r) => ({
					cloneUrl: r.clone_url,
					defaultBranch: r.default_branch,
					fullName: r.full_name,
					private: r.private,
				}));
			}
			case "bitbucket": {
				const res = await fetch(`${api}/repositories?role=member&pagelen=100`, {
					headers,
				});
				if (!res.ok) {
					throw new Error(`Couldn't list repos: ${res.status}`);
				}
				const body = (await res.json()) as {
					values: Array<{
						full_name: string;
						is_private: boolean;
						links: { clone: Array<{ href: string; name: string }> };
						mainbranch?: { name: string };
					}>;
				};
				return body.values.map((r) => ({
					cloneUrl:
						r.links.clone.find((c) => c.name === "https")?.href ??
						r.links.clone[0]?.href ??
						"",
					defaultBranch: r.mainbranch?.name ?? "main",
					fullName: r.full_name,
					private: r.is_private,
				}));
			}
			default: {
				const exhaustive: never = provider.kind;
				throw new Error(`Unknown git provider kind: ${exhaustive}`);
			}
		}
	}

	/**
	 * Calls the provider's REST API as the connection's account, refreshing
	 * its token first when needed.
	 *
	 * @throws When the token can't be decrypted, or the provider answers with
	 * an error: 401/403 almost always means the connection was authorized
	 * before Homerun asked for the scope this call needs, so the message says
	 * to reconnect.
	 */
	async api(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		path: string,
		init: { body?: Record<string, unknown>; method?: string } = {},
	): Promise<Response> {
		const accessToken = await this.accessToken(provider, connection);
		if (!accessToken) {
			throw new Error("Couldn't decrypt the stored access token.");
		}
		const res = await fetch(`${endpoints(provider).api}${path}`, {
			body: init.body ? JSON.stringify(init.body) : undefined,
			headers: {
				...authHeader(accessToken),
				Accept: "application/json",
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
			method: init.method ?? "GET",
		});
		if (res.status === 401 || res.status === 403) {
			throw refusalFrom(provider.name, res.status, await res.text());
		}
		if (!res.ok) {
			throw new Error(
				`${provider.name} answered ${res.status}: ${(await res.text()).slice(0, 300)}`,
			);
		}
		return res;
	}

	/** The branch names of `repo`, as the connection's account sees them (first 100). */
	async listBranches(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		repo: string,
	): Promise<string[]> {
		const path = {
			bitbucket: `/repositories/${repo}/refs/branches?pagelen=100`,
			gitea: `/repos/${repo}/branches?limit=50`,
			github: `/repos/${repo}/branches?per_page=100`,
			gitlab: `/projects/${encodeURIComponent(repo)}/repository/branches?per_page=100`,
		}[provider.kind];
		const body = (await (await this.api(provider, connection, path)).json()) as
			| Array<{ name: string }>
			| { values: Array<{ name: string }> };
		const rows = Array.isArray(body) ? body : body.values;
		return rows.map((row) => row.name);
	}

	/** The open pull requests of `repo` as `update` events, as the connection's account sees them (first page). */
	async listOpenPullRequests(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		repo: string,
	): Promise<PullRequestEvent[]> {
		const res = await this.api(
			provider,
			connection,
			openPullRequestsPath(provider.kind, repo),
		);
		return parseOpenPullRequests(provider.kind, await res.json());
	}

	/**
	 * Takes over the hook a GitHub or Gitea repo already has for `url` (left
	 * by an earlier connection or a deleted app), rewriting its secret and
	 * events to `request`'s, and answers with it. Null when there's no such
	 * hook or the provider isn't one that refuses duplicates.
	 */
	async #adoptWebhook(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		request: WebhookRequest,
		url: string,
	): Promise<Response | null> {
		if (!(provider.kind === "github" || provider.kind === "gitea")) {
			return null;
		}
		const listing = await this.api(provider, connection, request.path);
		const id = existingWebhookId(await listing.json(), url);
		if (!id) {
			return null;
		}
		const { active, config, events } = request.body;
		logger.info(`Adopting the existing webhook ${id} for ${url}`);
		return await this.api(provider, connection, `${request.path}/${id}`, {
			body: { active, config, events },
			method: "PATCH",
		});
	}

	/**
	 * Registers a webhook on `hook.repo` that delivers push events, pull
	 * request events when `hook.pullRequests` is set and tag pushes when
	 * `hook.tags` is set, to `hook.url`, signed with `hook.secret`.
	 *
	 * @returns The provider's id for the new hook, used to delete it later.
	 * @throws `GitProviderRefusedError` when the provider refuses (usually a
	 * connection missing the webhook scope), a plain error when it can't be
	 * reached or answers otherwise.
	 */
	async createPushWebhook(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		hook: {
			pullRequests?: boolean;
			repo: string;
			secret: string;
			tags?: boolean;
			url: string;
		},
	): Promise<string> {
		const request = createWebhookRequest(provider.kind, hook.repo, hook);
		const res = await this.api(provider, connection, request.path, {
			body: request.body,
			method: request.method,
		}).catch(async (err: unknown) => {
			const adopted =
				err instanceof Error && /already exists/i.test(err.message)
					? await this.#adoptWebhook(provider, connection, request, hook.url)
					: null;
			if (!adopted) {
				throw err;
			}
			return adopted;
		});
		const id = webhookIdFrom(
			provider.kind,
			(await res.json()) as Record<string, unknown>,
		);
		if (!id) {
			throw new Error(`${provider.name} didn't return an id for the webhook.`);
		}
		return id;
	}

	/** Removes a webhook Homerun registered. One that's already gone counts as removed. */
	async deletePushWebhook(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		repo: string,
		hookId: string,
	): Promise<void> {
		try {
			await this.api(
				provider,
				connection,
				deleteWebhookPath(provider.kind, repo, hookId),
				{ method: "DELETE" },
			);
		} catch (err) {
			if (err instanceof Error && err.message.includes("answered 404")) {
				return;
			}
			throw err;
		}
	}

	/** Whether `repoFullName` has a Dockerfile at its root, on the given ref. */
	async hasDockerfile(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		repoFullName: string,
		ref: string,
	): Promise<boolean> {
		const { api } = endpoints(provider);
		const accessToken = await this.accessToken(provider, connection);
		if (!accessToken) {
			return false;
		}
		const headers = authHeader(accessToken);

		try {
			let url: string;
			switch (provider.kind) {
				case "github":
				case "gitea":
					url = `${api}/repos/${repoFullName}/contents/Dockerfile?ref=${encodeURIComponent(ref)}`;
					break;
				case "gitlab":
					url = `${api}/projects/${encodeURIComponent(repoFullName)}/repository/files/Dockerfile?ref=${encodeURIComponent(
						ref,
					)}`;
					break;
				case "bitbucket":
					url = `${api}/repositories/${repoFullName}/src/${encodeURIComponent(ref)}/Dockerfile`;
					break;
				default: {
					const exhaustive: never = provider.kind;
					throw new Error(`Unknown git provider kind: ${exhaustive}`);
				}
			}
			const res = await fetch(url, { headers, method: "GET" });
			return res.ok;
		} catch (err) {
			logger.warn(`Dockerfile check failed: ${repoFullName}@${ref}`, err);
			return false;
		}
	}

	/**
	 * The contents of `file.path` in `file.repo` at `file.ref` (the default
	 * branch when empty), as the connection's account sees it.
	 *
	 * @returns The file's text, or null when it doesn't exist or can't be read.
	 */
	async readFile(
		provider: GitProviderConfig,
		connection: GitConnectionDTO,
		file: { path: string; ref: string; repo: string },
	): Promise<string | null> {
		const { path, ref, repo: repoFullName } = file;
		const { api } = endpoints(provider);
		const accessToken = await this.accessToken(provider, connection);
		if (!accessToken) {
			return null;
		}
		const at = ref ? `?ref=${encodeURIComponent(ref)}` : "";
		const url = {
			bitbucket: `${api}/repositories/${repoFullName}/src/${encodeURIComponent(ref || "HEAD")}/${path}`,
			gitea: `${api}/repos/${repoFullName}/raw/${path}${at}`,
			github: `${api}/repos/${repoFullName}/contents/${path}${at}`,
			gitlab: `${api}/projects/${encodeURIComponent(repoFullName)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref || "HEAD")}`,
		}[provider.kind];
		try {
			const res = await fetch(url, {
				headers: {
					...authHeader(accessToken),
					Accept: "application/vnd.github.raw",
				},
			});
			return res.ok ? await res.text() : null;
		} catch (err) {
			logger.warn(`File read failed: ${repoFullName}@${ref}:${path}`, err);
			return null;
		}
	}
}

export const GitProviderService = new GitProviderServiceClass();
