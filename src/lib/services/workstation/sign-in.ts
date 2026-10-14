import { createHmac } from "node:crypto";
import { config } from "#lib/config.js";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import {
	GATE_CALLBACK_PATH,
	GATE_GRANT_TTL_MS,
	GATE_REDIRECT_TTL_MS,
	GATE_SESSION_TTL_MS,
	type GateTarget,
	signGateToken,
	verifyGateToken,
} from "#lib/server/app-gate.js";
import type { GitProviderConfig, Workstation } from "#lib/server/db/schema.js";
import {
	enabledGitProvider,
	GitProviderService,
} from "#lib/services/git-provider.service.js";
import { workstationHostname } from "#lib/workstations.js";

const logger = new Logger("WorkstationSignIn");

const CACHE_TTL_MS = 10_000;

const STATE_PREFIX = "ws.";

/** What a git sign-in checks against: the owner's connected account on the workstation's provider. */
export interface WorkstationGate {
	hostname: string;
	id: string;
	ownerId: string;
	provider: GitProviderConfig;
	providerUsername: string;
	version: string;
}

/** The gate token's `serviceId` for a workstation, kept apart from real service ids. */
export function workstationGateKey(workstationId: string): string {
	return `workstation:${workstationId}`;
}

/** The workstation id a gate token's `serviceId` names, null when it names a service. */
export function workstationIdOf(gateKey: string): string | null {
	const prefix = workstationGateKey("");
	return gateKey.startsWith(prefix) ? gateKey.slice(prefix.length) : null;
}

/**
 * Workstation `row`'s own login wall as auth-check and `/app-auth` see it:
 * the same policy columns a service has, its one hostname, and its owner,
 * who always gets in.
 */
export function workstationWall(
	row: Omit<Workstation, "passwordEnc">,
): GateTarget {
	return {
		authAllowedEmails: row.authAllowedEmails,
		authAllowedGroups: row.authAllowedGroups,
		authAllowedUserIds: row.authAllowedUserIds,
		authProviders: row.authProviders,
		authRequired: row.authRequired,
		domains: [workstationHostname(row, config.baseDomain)],
		key: workstationGateKey(row.id),
		name: row.name,
		ownerId: row.userId,
	};
}

/** What forwardAuth needs to know about one workstation: its git sign-in, if any, and its login wall. */
interface GateEntry {
	fetchedAt: number;
	gate: WorkstationGate | null;
	wall: GateTarget | null;
}

/** Whether `image` is code-server, whose own password Homerun can turn off with `--auth none`. */
export function isCodeServerImage(image: string): boolean {
	return /(^|\/)code-server(:|@|$)/.test(image);
}

/**
 * Signs a workstation's owner in to its IDE through the OAuth app of the git
 * provider the workstation is set to use, instead of the IDE's own password.
 * Traefik's forwardAuth sends an anonymous visitor to the provider's consent
 * screen; the provider's callback lands on Homerun's usual git provider
 * callback, which only lets the owner's own connected account through and
 * hands a one-minute grant back to the workstation's host, where the login
 * wall's session cookie is set.
 */
class WorkstationSignInServiceClass {
	readonly #cache = new Map<string, GateEntry>();

	/**
	 * Whether `ws` signs in through git: it has a git provider picked, the
	 * provider is enabled, its owner is still connected to it, and Homerun
	 * knows its own public URL to send the provider back to.
	 */
	async gateFor(
		ws: Omit<Workstation, "passwordEnc">,
	): Promise<WorkstationGate | null> {
		if (!(ws.gitProviderId && config.auth.origin)) {
			return null;
		}
		const provider = await enabledGitProvider(ws.gitProviderId);
		if (!provider) {
			return null;
		}
		const connection = await GitConnectionDTO.getForUserAndProvider(
			ws.userId,
			provider.id,
		);
		if (!connection) {
			return null;
		}
		const providerUsername = connection.toJSON().providerUsername;
		return {
			hostname: workstationHostname(ws, config.baseDomain),
			id: ws.id,
			ownerId: ws.userId,
			provider,
			providerUsername,
			version: this.#version(ws.id, ws.userId, provider.id, providerUsername),
		};
	}

	/**
	 * The git sign-in gate of workstation `id`, cached for ten seconds (a miss
	 * included), since forwardAuth asks on every request to the IDE.
	 */
	async gate(id: string): Promise<WorkstationGate | null> {
		return (await this.#entry(id)).gate;
	}

	/**
	 * The login wall of workstation `id` (on or off), null when it's gone,
	 * cached alongside its git sign-in gate.
	 */
	async wall(id: string): Promise<GateTarget | null> {
		return (await this.#entry(id)).wall;
	}

	/** Workstation `id`'s cached gate and wall, read again once ten seconds old. */
	async #entry(id: string): Promise<GateEntry> {
		const hit = this.#cache.get(id);
		if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
			return hit;
		}
		const row = (await WorkstationDTO.getForGate(id))?.toPublic();
		const entry: GateEntry = {
			fetchedAt: Date.now(),
			gate: row ? await this.gateFor(row) : null,
			wall: row ? workstationWall(row) : null,
		};
		this.#cache.set(id, entry);
		return entry;
	}

	/** Drops workstation `id`'s cached gate and wall, so a settings change applies at once. */
	forget(id: string): void {
		this.#cache.delete(id);
	}

	/** A short fingerprint of who may sign in, so reconnecting another account revokes old sessions. */
	#version(
		id: string,
		ownerId: string,
		providerId: string,
		username: string,
	): string {
		return createHmac("sha256", config.auth.secret)
			.update(`${id}:${ownerId}:${providerId}:${username.toLowerCase()}`)
			.digest("base64url")
			.slice(0, 16);
	}

	/** The provider's callback URL, the one its OAuth app is registered with. */
	#redirectUri(provider: GitProviderConfig): string {
		const origin = (config.auth.origin ?? "").replace(/\/+$/, "");
		return `${origin}/api/v1/git-providers/${provider.id}/callback`;
	}

	/**
	 * Where to send an anonymous visitor of `host`: the provider's consent
	 * screen, with a signed state that brings them back to `target`.
	 */
	challengeUrl(gate: WorkstationGate, host: string, target: string): string {
		const state = signGateToken(
			{ host, serviceId: workstationGateKey(gate.id), target },
			GATE_REDIRECT_TTL_MS,
		);
		return GitProviderService.authorizeUrl(
			gate.provider,
			`${STATE_PREFIX}${state}`,
			this.#redirectUri(gate.provider),
		);
	}

	/** Whether an OAuth state came from a workstation sign-in rather than a connect. */
	ownsState(state: string): boolean {
		return state.startsWith(STATE_PREFIX);
	}

	/**
	 * Finishes a sign-in on the provider callback: checks the state, trades
	 * the code for the visitor's account, and lets only the workstation
	 * owner's connected account through. The token itself is thrown away.
	 *
	 * @returns The workstation host's grant URL, which sets its session.
	 * @throws When the state is bad or expired, the workstation no longer
	 *   signs in through this provider, the exchange fails, or the account
	 *   isn't the owner's.
	 */
	async complete(
		providerId: string,
		code: string,
		state: string,
	): Promise<string> {
		const payload = verifyGateToken(state.slice(STATE_PREFIX.length));
		const id = payload ? workstationIdOf(payload.serviceId) : null;
		if (!(payload && id)) {
			throw new Error("This sign-in link expired. Open the workstation again.");
		}
		this.forget(id);
		const gate = await this.gate(id);
		if (
			!gate ||
			gate.provider.id !== providerId ||
			gate.hostname !== payload.host
		) {
			throw new Error(
				"This workstation doesn't sign in through that git provider any more.",
			);
		}
		const exchanged = await GitProviderService.exchangeCode(
			gate.provider,
			code,
			this.#redirectUri(gate.provider),
		);
		if (
			exchanged.providerUsername.toLowerCase() !==
			gate.providerUsername.toLowerCase()
		) {
			logger.warn(
				`Workstation sign-in refused: workstation=${id} account=${exchanged.providerUsername}`,
			);
			throw new Error(
				`Only ${gate.providerUsername} on ${gate.provider.name} can open this workstation.`,
			);
		}
		const grant = signGateToken(
			{
				host: payload.host,
				serviceId: workstationGateKey(id),
				target: payload.target,
				userId: gate.ownerId,
			},
			GATE_GRANT_TTL_MS,
		);
		const url = new URL(GATE_CALLBACK_PATH, `https://${payload.host}`);
		if (payload.target) {
			url.protocol = new URL(payload.target).protocol;
		}
		url.searchParams.set("token", grant);
		logger.info(`Workstation sign-in granted: workstation=${id}`);
		return url.toString();
	}

	/** The login wall session token for the owner on `host`. */
	session(gate: WorkstationGate, host: string): string {
		return signGateToken(
			{
				host,
				policyVersion: gate.version,
				serviceId: workstationGateKey(gate.id),
				userId: gate.ownerId,
			},
			GATE_SESSION_TTL_MS,
		);
	}
}

export const WorkstationSignInService = new WorkstationSignInServiceClass();
