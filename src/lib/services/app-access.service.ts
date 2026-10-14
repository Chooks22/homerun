import { eq } from "drizzle-orm";
import {
	acceptsEmailSignIn,
	accountProviderIdFor,
	emailMatchesPattern,
} from "#lib/auth-providers.js";
import { config } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { db } from "#lib/server/db/lib.js";
import {
	account as accountTable,
	type Service,
	user as userTable,
} from "#lib/server/db/schema.js";
import { primaryHostname } from "#lib/service-domains.js";
import { isServiceAccount } from "#lib/user-types.js";
import { emailSignInAvailability } from "./email-sign-in.ts";

const GROUP_CLAIMS = ["groups", "roles", "grp"];

const PROVIDER_REFRESH_MS = 5 * 60 * 1000;

const logger = new Logger("AppAccess");

export type AccessDenialReason =
	| "no-method-configured"
	| "method-not-linked"
	| "user-not-allowed"
	| "email-not-allowed"
	| "group-not-allowed";

export interface AccessDecision {
	allowed: boolean;
	reason?: AccessDenialReason;
}

export const ACCESS_DENIAL_MESSAGES: Record<AccessDenialReason, string> = {
	"email-not-allowed": "Your email address isn't on this app's allowed list.",
	"group-not-allowed":
		"Your identity provider didn't return a group this app allows.",
	"method-not-linked":
		"Your account isn't linked to a sign-in method this app accepts.",
	"no-method-configured":
		"This app has no sign-in method configured yet, so nobody can be let through. An admin needs to pick one on its Security tab.",
	"user-not-allowed": "You're not on this app's allowed user list.",
};

function decodeJwtClaims(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length < 2) {
		return null;
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function collectStrings(value: unknown, into: Set<string>): void {
	if (typeof value === "string") {
		into.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectStrings(entry, into);
		}
	}
}

/**
 * Decodes an OIDC id token's payload (no signature verification, the token
 * already came from a trusted provider round-trip) and collects the group
 * names it carries: any of `GROUP_CLAIMS` at the top level, plus Keycloak's
 * `realm_access.roles` and `resource_access.*.roles` shapes. Returns an
 * empty set rather than throwing if the token can't be decoded.
 */
export function groupsFromIdToken(idToken: string): Set<string> {
	const groups = new Set<string>();
	const claims = decodeJwtClaims(idToken);
	if (!claims) {
		return groups;
	}
	for (const claim of GROUP_CLAIMS) {
		collectStrings(claims[claim], groups);
	}
	const realmAccess = claims.realm_access;
	if (realmAccess && typeof realmAccess === "object") {
		collectStrings((realmAccess as Record<string, unknown>).roles, groups);
	}
	const resourceAccess = claims.resource_access;
	if (resourceAccess && typeof resourceAccess === "object") {
		for (const entry of Object.values(
			resourceAccess as Record<string, unknown>,
		)) {
			if (entry && typeof entry === "object") {
				collectStrings((entry as Record<string, unknown>).roles, groups);
			}
		}
	}
	return groups;
}

interface LinkedAccount {
	id: string;
	idToken: string | null;
	providerId: string;
	refreshToken: string | null;
}

interface GateUser {
	banExpires: Date | null;
	banned: boolean | null;
	email: string;
	role: string | null;
	type: string;
}

/**
 * Whether a user row is currently banned by better-auth's admin plugin: banned
 * with no expiry, or with an expiry still in the future.
 */
export function isBanned(
	user: Pick<GateUser, "banExpires" | "banned">,
	now: Date = new Date(),
): boolean {
	return !!user.banned && (!user.banExpires || user.banExpires > now);
}

/**
 * The group names a user carries for a login wall's group allowlist: every
 * group claim across their linked accounts' id tokens, plus their Homerun role,
 * so changing someone's role on /users re-groups them for gated apps too.
 */
export function groupsAcross(
	accounts: Pick<LinkedAccount, "idToken">[],
	role: string | null = null,
): Set<string> {
	const groups = new Set<string>();
	if (role) {
		groups.add(role);
	}
	for (const entry of accounts) {
		if (!entry.idToken) {
			continue;
		}
		for (const group of groupsFromIdToken(entry.idToken)) {
			groups.add(group);
		}
	}
	return groups;
}

function emailAllowed(svc: ServiceDTO, email: string): boolean {
	return (
		svc.authAllowedEmails.length === 0 ||
		svc.authAllowedEmails.some((pattern) => emailMatchesPattern(email, pattern))
	);
}

export interface SharedApp {
	canary: boolean;
	id: string;
	name: string;
	pullRequest: { number: number; title: string | null } | null;
	url: string;
}

type SharedAppRow = Pick<
	Service,
	| "channelCanary"
	| "defaultDomainEnabled"
	| "dnsResolvable"
	| "domains"
	| "id"
	| "name"
	| "previewPrNumber"
	| "previewPrTitle"
	| "primaryDomain"
	| "slug"
>;

/**
 * The links for the login-wall apps a user may open, from services already
 * known to let them through: each one's primary hostname over https, skipping
 * a service with nothing routed or not published in DNS, sorted by name. A pull
 * request preview carries its number and title so a client can tell which
 * change they're looking at; a release channel canary is flagged as such,
 * never as a pull request.
 */
export function sharedAppLinks(
	entries: { row: SharedAppRow; stackSlug: string | null }[],
	baseDomain: string,
): SharedApp[] {
	return entries
		.flatMap(({ row, stackSlug }) => {
			const host = row.dnsResolvable
				? primaryHostname(row, stackSlug, baseDomain)
				: null;
			if (!host) {
				return [];
			}
			return [
				{
					canary: row.channelCanary,
					id: row.id,
					name: row.name,
					pullRequest:
						row.channelCanary || row.previewPrNumber === null
							? null
							: { number: row.previewPrNumber, title: row.previewPrTitle },
					url: `https://${host}`,
				},
			];
		})
		.toSorted((a, b) => a.name.localeCompare(b.name));
}

class AppAccessServiceClass {
	readonly #lastProviderRefresh = new Map<string, number>();

	/**
	 * Decides whether `userId` may access `svc`'s per-app login wall,
	 * checking, in order: a sign-in method is configured at all, an explicit
	 * allowed-user-id list, that the user still exists and isn't banned, their
	 * email against `authAllowedEmails`, that they have actually linked one of
	 * `svc.authProviders` (an emailed code or link, while available, counts as
	 * linked for every account: it signs in on the email address alone), and
	 * (if set) that their linked accounts' OIDC groups
	 * or their Homerun role intersect `authAllowedGroups`.
	 *
	 * A service account never signs in interactively, so its API key stands
	 * in for the sign-in method: it's let through only when the wall lists it
	 * by id and it isn't disabled, whatever the email, method and group rules
	 * say.
	 */
	async evaluate(svc: ServiceDTO, userId: string): Promise<AccessDecision> {
		if (svc.authProviders.length === 0) {
			return { allowed: false, reason: "no-method-configured" };
		}
		if (
			svc.authAllowedUserIds.length > 0 &&
			!svc.authAllowedUserIds.includes(userId)
		) {
			return { allowed: false, reason: "user-not-allowed" };
		}

		const [account, linked] = await Promise.all([
			this.#userFor(userId),
			this.#linkedAccounts(svc, userId),
		]);
		if (!account || isBanned(account)) {
			return { allowed: false, reason: "user-not-allowed" };
		}
		if (isServiceAccount(account)) {
			return svc.authAllowedUserIds.includes(userId)
				? { allowed: true }
				: { allowed: false, reason: "user-not-allowed" };
		}
		if (!emailAllowed(svc, account.email)) {
			return { allowed: false, reason: "email-not-allowed" };
		}
		if (linked.length === 0 && !(await this.#acceptsEmail(svc))) {
			return { allowed: false, reason: "method-not-linked" };
		}
		if (svc.authAllowedGroups.length > 0) {
			const groups = groupsAcross(linked, account.role);
			if (!svc.authAllowedGroups.some((group) => groups.has(group))) {
				return { allowed: false, reason: "group-not-allowed" };
			}
		}
		return { allowed: true };
	}

	/**
	 * Every app behind a login wall that `userId` would be let through right
	 * now, as links for the "apps shared with you" page. Runs the full
	 * `evaluate()` per gated service.
	 */
	async sharedApps(userId: string): Promise<SharedApp[]> {
		const gated = (await ServiceDTO.list()).filter((svc) => svc.authRequired);
		const decisions = await Promise.all(
			gated.map((svc) => this.evaluate(svc, userId)),
		);
		const allowed = gated.filter((_, index) => decisions[index].allowed);
		if (allowed.length === 0) {
			return [];
		}
		const stackSlugs = new Map(
			(await StackDTO.list()).map((stack) => [stack.id, stack.slug]),
		);
		return sharedAppLinks(
			allowed.map((svc) => {
				const row = svc.toJSON();
				return {
					row,
					stackSlug: row.stackId ? (stackSlugs.get(row.stackId) ?? null) : null,
				};
			}),
			config.baseDomain,
		);
	}

	/**
	 * Re-evaluates a login-wall cookie holder's access for auth-check's periodic
	 * re-check. When the service filters on groups, first asks the user's OAuth
	 * providers for fresh tokens (at most once every five minutes per user) so a
	 * group removed at the provider is seen well before the cookie expires. A
	 * failed refresh is logged and the stored id token is used instead.
	 */
	async recheck(svc: ServiceDTO, userId: string): Promise<boolean> {
		if (svc.authAllowedGroups.length > 0) {
			await this.#refreshProviderTokens(svc, userId);
		}
		return (await this.evaluate(svc, userId)).allowed;
	}

	/** Refreshes the user's allowed OAuth accounts' tokens through better-auth, throttled per user; never throws. */
	async #refreshProviderTokens(svc: ServiceDTO, userId: string): Promise<void> {
		const now = Date.now();
		const last = this.#lastProviderRefresh.get(userId);
		if (last !== undefined && now - last < PROVIDER_REFRESH_MS) {
			return;
		}
		this.#lastProviderRefresh.set(userId, now);
		const accounts = (await this.#linkedAccounts(svc, userId)).filter(
			(entry) => entry.refreshToken && entry.providerId !== "credential",
		);
		if (accounts.length === 0) {
			return;
		}
		const { auth } = await import("#lib/services/auth.js");
		await Promise.all(
			accounts.map(async (entry) => {
				try {
					await auth.api.refreshToken({
						body: { accountId: entry.id, userId },
					});
				} catch (error) {
					logger.warn(
						`Provider token refresh failed: user=${userId} provider=${entry.providerId}: ${error}`,
					);
				}
			}),
		);
	}

	/** Whether the wall allows an emailed code or link that's available right now; skips the settings read when it allows neither. */
	async #acceptsEmail(svc: ServiceDTO): Promise<boolean> {
		if (
			!acceptsEmailSignIn(svc.authProviders, {
				emailOtp: true,
				magicLink: true,
			})
		) {
			return false;
		}
		return acceptsEmailSignIn(
			svc.authProviders,
			await emailSignInAvailability(),
		);
	}

	/** The user's email, role and ban state, or null if the user row doesn't exist. */
	async #userFor(userId: string): Promise<GateUser | null> {
		const [row] = await db
			.select({
				banExpires: userTable.banExpires,
				banned: userTable.banned,
				email: userTable.email,
				role: userTable.role,
				type: userTable.type,
			})
			.from(userTable)
			.where(eq(userTable.id, userId))
			.limit(1);
		return row ?? null;
	}

	/** The user's linked accounts whose provider maps to one of `svc.authProviders`, each with its id token for group extraction. */
	async #linkedAccounts(
		svc: ServiceDTO,
		userId: string,
	): Promise<LinkedAccount[]> {
		const allowed = new Set(svc.authProviders.map(accountProviderIdFor));
		const accounts = await db
			.select({
				id: accountTable.id,
				idToken: accountTable.idToken,
				providerId: accountTable.providerId,
				refreshToken: accountTable.refreshToken,
			})
			.from(accountTable)
			.where(eq(accountTable.userId, userId));
		return accounts.filter((a) => allowed.has(a.providerId));
	}
}

export const AppAccessService = new AppAccessServiceClass();
