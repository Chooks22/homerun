import { connect } from "node:tls";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { RegistryTokenDTO } from "#lib/dto/registry-token-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import {
	certificateCheck,
	publicProbeCheck,
	type RegistryCheck,
} from "#lib/registry-self-test.js";
import type { ListQuery, PagedResult } from "#lib/server/list-query.js";
import { syncCoreHostDns } from "./dns.service.ts";
import {
	MIRROR_HOST_PORT,
	mirrorRepository,
	REGISTRY_INTERNAL_USERNAME,
} from "./docker/image-scan-refs.ts";
import { DockerService } from "./docker.service.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const logger = new Logger("Registry");

/** The reserved token Homerun's own scan and deploy pipeline authenticates with once auth is on. */
export const INTERNAL_USERNAME = REGISTRY_INTERNAL_USERNAME;

/** What a `docker login` needs, and what skopeo/trivy and the worker's own pulls are handed internally. */
export interface RegistryCredentials {
	password: string;
	username: string;
}

/** One repository in the registry, with the tags it holds and what still uses it. */
export interface RegistryRepository {
	repository: string;
	tags: RegistryTag[];
	usedBy: RegistryUser[];
}

/** A service whose image lives in a registry repository. */
export interface RegistryUser {
	id: string;
	name: string;
}

/** One tag, with the digest it currently points at. */
export interface RegistryTag {
	digest: string | null;
	tag: string;
}

/** Everything the Registry page needs to describe the registry itself. */
export interface RegistryStatus {
	authEnabled: boolean;
	internalEndpoint: string;
	publicHost: string | null;
	pushEndpoint: string | null;
	running: boolean;
	sizeBytes: number | null;
	tokenCount: number;
}

/** A newly created token: the only time its secret is ever readable. */
export interface CreatedToken {
	id: string;
	secret: string;
	username: string;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const CERT_ERROR_RE = /certificate|cert_|self[- ]signed|verify/i;

/**
 * The built-in registry: the same `homerun-mirror` container image scanning
 * pulls through, optionally turned into a real private registry that can be
 * pushed to.
 *
 * Auth is htpasswd, the only mechanism registry:2 supports without a separate
 * token server, which is why a token can always both push and pull: per-scope
 * access would need that server. Turning auth on also mints the reserved
 * `homerun-internal` token, because the moment the registry requires
 * credentials, Homerun's own mirror copies and scans need them too.
 */
class RegistryServiceClass {
	/**
	 * Checks the registry end to end: the internal API answers with Homerun's
	 * own credentials, and, when it's published, `https://<host>/v2/` answers
	 * over a certificate that verifies and demands a token. Never throws: every
	 * failure comes back as a failed check with its reason.
	 */
	async selfTest(): Promise<RegistryCheck[]> {
		const checks: RegistryCheck[] = [];
		try {
			await DockerService.imageMirrorClient();
			checks.push({
				detail: "The registry API answers Homerun's own credentials.",
				label: "Internal registry",
				ok: true,
			});
		} catch (error) {
			checks.push({
				detail: error instanceof Error ? error.message : String(error),
				label: "Internal registry",
				ok: false,
			});
		}
		const host = (await InstanceSettingsDTO.get()).toJSON().registryPublicHost;
		if (host) {
			checks.push(await this.#probePublic(host));
		}
		return checks;
	}

	/** Fetches `https://<host>/v2/`, reading the served certificate when it doesn't verify. */
	async #probePublic(host: string): Promise<RegistryCheck> {
		try {
			const response = await fetch(`https://${host}/v2/`, {
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			});
			return publicProbeCheck(host, response.status);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const subject = CERT_ERROR_RE.test(message)
				? await this.#servedCertificate(host)
				: undefined;
			return subject === undefined
				? {
						detail: `Unreachable: ${message}`,
						label: `https://${host}`,
						ok: false,
					}
				: certificateCheck(host, message, subject);
		}
	}

	/** The subject of the certificate `host` serves, null when it has none readable, undefined when no TLS connection could be made. */
	#servedCertificate(host: string): Promise<string | null | undefined> {
		return new Promise((resolve) => {
			const socket = connect({
				host,
				port: 443,
				rejectUnauthorized: false,
				servername: host,
			});
			socket.setTimeout(5000, () => {
				socket.destroy();
				resolve(undefined);
			});
			socket.once("error", () => resolve(undefined));
			socket.once("secureConnect", () => {
				const cert = socket.getPeerCertificate();
				socket.end();
				resolve(
					cert?.subject?.CN
						? String(cert.subject.CN)
						: (cert?.subjectaltname ?? null),
				);
			});
		});
	}

	/** Whether a username is well-formed and not reserved for Homerun's own token. */
	validateUsername(username: string): string | null {
		if (!USERNAME_RE.test(username)) {
			return "A username is 3 to 32 characters, lowercase letters, digits, dashes or underscores, starting with a letter or digit.";
		}
		if (username === INTERNAL_USERNAME) {
			return `"${INTERNAL_USERNAME}" is reserved for Homerun's own pulls.`;
		}
		return null;
	}

	/** The registry's current state, for the Registry page's header and Settings tab. */
	async status(): Promise<RegistryStatus> {
		const settings = await InstanceSettingsDTO.get();
		const running = await DockerService.imageMirrorRunning().catch(() => false);
		const publicHost = settings.toJSON().registryPublicHost ?? null;
		return {
			authEnabled: await this.authEnabled(),
			internalEndpoint: `127.0.0.1:${MIRROR_HOST_PORT}`,
			publicHost,
			pushEndpoint: publicHost,
			running,
			sizeBytes: running ? await DockerService.imageMirrorUsageBytes() : null,
			tokenCount: (await RegistryTokenDTO.list()).length,
		};
	}

	/** Whether htpasswd auth is currently turned on. */
	async authEnabled(): Promise<boolean> {
		const settings = await InstanceSettingsDTO.get();
		return settings.toJSON().registryAuthEnabled === true;
	}

	/**
	 * The credentials Homerun's own pipeline uses, or null when auth is off and
	 * anonymous access still works.
	 */
	async internalCredentials(): Promise<RegistryCredentials | null> {
		const settings = (await InstanceSettingsDTO.get()).toJSON();
		if (settings.registryAuthEnabled !== true) {
			return null;
		}
		const secret = settings.registryInternalSecretEnc
			? decryptSecret(settings.registryInternalSecretEnc)
			: null;
		if (!secret) {
			logger.warn(
				"Registry auth is on but the internal token's secret is unreadable : rotating it.",
			);
			return {
				password: await this.#rotateInternalSecret(),
				username: INTERNAL_USERNAME,
			};
		}
		return { password: secret, username: INTERNAL_USERNAME };
	}

	/** Lists every token, newest first. Secrets aren't stored, so only the usernames come back. */
	async listTokens(): Promise<RegistryTokenDTO[]> {
		return await RegistryTokenDTO.list();
	}

	/**
	 * Creates a push/pull token and, when auth is on, re-syncs the registry's
	 * htpasswd file, deleting the token again if that sync fails.
	 *
	 * @returns The token's id, its username and the generated secret, which is readable this once and never again.
	 * @throws When the username is invalid or already taken, or the sync fails.
	 */
	async createToken(username: string, userId: string): Promise<CreatedToken> {
		const invalid = this.validateUsername(username);
		if (invalid) {
			throw new Error(invalid);
		}
		if (await RegistryTokenDTO.usernameTaken(username)) {
			throw new Error(`"${username}" already has a token.`);
		}
		const secret = this.#generateSecret();
		const token = await RegistryTokenDTO.create({
			secretHash: await this.#hash(secret),
			userId,
			username,
		});
		if (await this.authEnabled()) {
			await this.syncAuth().catch(async (error: unknown) => {
				await token.delete();
				throw error;
			});
		}
		logger.info(`Registry token created: ${username}`);
		return { id: token.toJSON().id, secret, username };
	}

	/** Deletes a token and, when auth is on, re-syncs the htpasswd file, which is what actually revokes it. */
	async revokeToken(id: string): Promise<void> {
		const token = await RegistryTokenDTO.get(id);
		if (!token) {
			throw new Error("That token no longer exists.");
		}
		await token.delete();
		if (await this.authEnabled()) {
			await this.syncAuth();
		}
		logger.info(`Registry token revoked: ${token.username}`);
	}

	/** Why auth can't be set to `enabled` right now, or null, checked before the change is queued. */
	async authProblem(enabled: boolean): Promise<string | null> {
		const settings = (await InstanceSettingsDTO.get()).toJSON();
		return !enabled && settings.registryPublicHost
			? "The registry is exposed publicly : remove its hostname before turning auth off, or anyone could push to it."
			: null;
	}

	/** Why the registry can't be published at `host` right now, or null, checked before the change is queued. */
	async publicHostProblem(host: string): Promise<string | null> {
		return host.trim() && !(await this.authEnabled())
			? "Turn auth on first : a registry reachable from the internet has to require credentials."
			: null;
	}

	/**
	 * Turns htpasswd auth on or off, minting the internal token on the way on,
	 * then rewrites the auth file and recreates the container so the registry
	 * picks it up.
	 *
	 * @throws When turning auth off while the registry is publicly exposed.
	 */
	async setAuthEnabled(enabled: boolean): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		if (!enabled && settings.toJSON().registryPublicHost) {
			throw new Error(
				"The registry is exposed publicly : remove its hostname before turning auth off, or anyone could push to it.",
			);
		}
		if (enabled && !settings.toJSON().registryInternalSecretEnc) {
			await this.#rotateInternalSecret();
		}
		await settings.persistRegistry({ registryAuthEnabled: enabled });
		await this.syncAuth();
	}

	/**
	 * Publishes the registry at `host` through Traefik, or unpublishes it when
	 * `host` is empty, and moves its DNS record or Pangolin resource along.
	 *
	 * @throws When publishing while auth is off : an open registry anyone can
	 *   push to is never what's wanted.
	 */
	async setPublicHost(host: string): Promise<void> {
		const trimmed = host.trim().toLowerCase();
		if (trimmed && !(await this.authEnabled())) {
			throw new Error(
				"Turn auth on first : a registry reachable from the internet has to require credentials.",
			);
		}
		const settings = await InstanceSettingsDTO.get();
		const previous = settings.toJSON().registryPublicHost ?? null;
		await settings.persistRegistry({ registryPublicHost: trimmed || null });
		await this.syncAuth();
		void syncCoreHostDns("Registry", previous, trimmed || null);
	}

	/**
	 * Rewrites the registry's htpasswd file from the current tokens and
	 * reconciles the container with the current settings (auth env, Traefik
	 * labels), recreating it when they've changed. The storage volume, and so
	 * every image in it, survives that.
	 */
	async syncAuth(): Promise<void> {
		const settings = (await InstanceSettingsDTO.get()).toJSON();
		const enabled = settings.registryAuthEnabled === true;
		const lines: string[] = [];
		if (enabled) {
			const internal = await this.internalCredentials();
			if (internal) {
				lines.push(
					`${internal.username}:${await this.#hash(internal.password)}`,
				);
			}
			for (const token of await RegistryTokenDTO.list()) {
				lines.push(`${token.username}:${token.secretHash}`);
			}
		}
		await DockerService.writeRegistryHtpasswd(lines.join("\n"));
		await DockerService.reconcileRegistry({
			authEnabled: enabled,
			publicHost: settings.registryPublicHost ?? null,
		});
	}

	/**
	 * One page of the registry's repositories, in name order, narrowed to the
	 * ones whose name contains `query.q`: the catalog is one request, and only
	 * the page's repositories have their tags read, in parallel, so a big
	 * registry doesn't slow the page down.
	 */
	async catalogPage(
		query: ListQuery,
	): Promise<PagedResult<RegistryRepository>> {
		const client = await DockerService.imageMirrorClient();
		const needle = query.q.trim().toLowerCase();
		const matching = (await client.catalog())
			.filter((repository) => repository.toLowerCase().includes(needle))
			.sort();
		const usedBy = await this.#usedBy();
		const items = await Promise.all(
			matching
				.slice(query.offset, query.offset + query.limit)
				.map(async (repository) => ({
					repository,
					tags: (await client.inventory(repository)).map((entry) => ({
						digest: entry.digest,
						tag: entry.tag,
					})),
					usedBy: usedBy.get(repository) ?? [],
				})),
		);
		return {
			items,
			page: query.page,
			perPage: query.perPage,
			total: matching.length,
		};
	}

	/**
	 * One repository with its tags and the services using it, or null when the
	 * registry holds no tag for it.
	 */
	async repository(repository: string): Promise<RegistryRepository | null> {
		const client = await DockerService.imageMirrorClient();
		const tags = (await client.inventory(repository)).map((entry) => ({
			digest: entry.digest,
			tag: entry.tag,
		}));
		if (tags.length === 0) {
			return null;
		}
		const usedBy = await this.#usedBy();
		return { repository, tags, usedBy: usedBy.get(repository) ?? [] };
	}

	/** The services whose image lives in each mirror repository, by name. */
	async #usedBy(): Promise<Map<string, RegistryUser[]>> {
		const usedBy = new Map<string, RegistryUser[]>();
		for (const svc of (await ServiceDTO.list()).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const repository = mirrorRepository(svc.image, svc.tag);
			usedBy.set(repository, [
				...(usedBy.get(repository) ?? []),
				{ id: svc.id, name: svc.name },
			]);
		}
		return usedBy;
	}

	/**
	 * Deletes one tag by resolving it to its manifest digest. Other tags on the
	 * same digest go with it : that's how registry:2 deletes work, there's no
	 * per-tag delete.
	 *
	 * @returns Whether anything was actually deleted.
	 */
	async deleteTag(repository: string, tag: string): Promise<boolean> {
		const client = await DockerService.imageMirrorClient();
		const digest = await client.digest(repository, tag);
		if (!digest) {
			return false;
		}
		return await client.deleteManifest({ digest, repository });
	}

	/** Deletes every tag in a repository. The space itself comes back on the next garbage collection. */
	async deleteRepository(repository: string): Promise<number> {
		const client = await DockerService.imageMirrorClient();
		const inventory = await client.inventory(repository);
		const digests = new Set(
			inventory.map((entry) => entry.digest).filter(Boolean),
		);
		let deleted = 0;
		for (const digest of digests) {
			// oxlint-disable-next-line no-await-in-loop -- deletes are one manifest at a time
			if (await client.deleteManifest({ digest, repository })) {
				deleted += 1;
			}
		}
		logger.info(`Registry repository emptied: ${repository} (${deleted})`);
		return deleted;
	}

	/** Generates a new internal secret, stores it encrypted, and returns the plaintext. */
	async #rotateInternalSecret(): Promise<string> {
		const secret = this.#generateSecret();
		const settings = await InstanceSettingsDTO.get();
		await settings.persistRegistry({
			registryInternalSecretEnc: encryptSecret(secret),
		});
		return secret;
	}

	/** A 32-byte URL-safe secret, the plaintext half of a token. */
	#generateSecret(): string {
		return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
			"base64url",
		);
	}

	/** bcrypt, the only hash registry:2's htpasswd auth accepts. */
	async #hash(secret: string): Promise<string> {
		return await Bun.password.hash(secret, { algorithm: "bcrypt", cost: 10 });
	}
}

export const RegistryService = new RegistryServiceClass();
