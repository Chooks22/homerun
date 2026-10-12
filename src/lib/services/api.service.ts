import type { RegistryTag } from "#lib/image-versions.js";
import { Logger } from "#lib/logger.js";
import {
	parseImageRef,
	parseWwwAuthenticate,
	type WwwAuthenticate,
} from "#lib/registry-ref.js";
import type { RegistryAuth } from "./docker/containers.ts";

const logger = new Logger("Docker");

/**
 * Fetches an anonymous (or Basic-auth-backed, when `auth` is given) bearer
 * token from the registry's token realm, per the Docker Registry v2 auth
 * flow. Makes a network request to `challenge.realm`; returns null on any
 * non-2xx response or a missing token in the body, never throws.
 */
async function fetchBearerToken(
	challenge: WwwAuthenticate,
	auth?: RegistryAuth,
): Promise<string | null> {
	const url = new URL(challenge.realm);
	if (challenge.service) {
		url.searchParams.set("service", challenge.service);
	}
	if (challenge.scope) {
		url.searchParams.set("scope", challenge.scope);
	}

	const headers: Record<string, string> = {};
	if (auth?.username) {
		headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
	}

	const res = await fetch(url, { headers });
	if (!res.ok) {
		return null;
	}
	const body = (await res.json()) as { token?: string; access_token?: string };
	return body.token ?? body.access_token ?? null;
}

const MANIFEST_ACCEPT = [
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.oci.image.index.v1+json",
].join(", ");

const DOCKER_HUB_API = "https://hub.docker.com/v2/repositories";
const DOCKER_HUB_PAGE_SIZE = 100;
const DOCKER_HUB_MAX_PAGES = 10;
const REGISTRY_PAGE_SIZE = 1000;
const REGISTRY_MAX_PAGES = 10;
const DIGEST_LOOKUP_LIMIT = 60;
const LINK_NEXT_RE = /<([^>]+)>;\s*rel="next"/;

interface DockerHubTagPage {
	next: string | null;
	results: { digest?: string | null; name: string }[];
}

/**
 * Outbound HTTP calls to third-party APIs : currently just container
 * registries (via the Docker Registry HTTP API v2), distinct from
 * DockerService which only talks to a Docker daemon (local or remote).
 */
class ApiServiceClass {
	/**
	 * Sends one registry request, answering a 401 Bearer challenge with a
	 * token from its realm (anonymous, or Basic-auth-backed when `auth` is
	 * given) and retrying once. Returns the last response, whatever its
	 * status; throws only on network failure.
	 */
	async #registryFetch(
		url: string,
		init: { accept?: string; method: string },
		auth?: RegistryAuth,
	): Promise<Response> {
		const headers: Record<string, string> = init.accept
			? { Accept: init.accept }
			: {};
		const res = await fetch(url, { headers, method: init.method });
		if (res.status !== 401) {
			return res;
		}
		const challenge = res.headers.get("www-authenticate");
		const parsed = challenge ? parseWwwAuthenticate(challenge) : null;
		const token = parsed ? await fetchBearerToken(parsed, auth) : null;
		if (!token) {
			return res;
		}
		return fetch(url, {
			headers: { ...headers, Authorization: `Bearer ${token}` },
			method: init.method,
		});
	}

	/**
	 * Checks whether `image:tag` exists in its registry, via the Docker
	 * Registry HTTP API v2 (a manifest HEAD, not a pull : no layers ever
	 * touch disk). Anonymous-token flow covers public images on Docker Hub,
	 * GHCR, etc.; `auth` is used for private registries.
	 *
	 * Fails open (`exists: true`) on network/parse trouble : this is a
	 * warn-don't-block check, a false negative is worse than a missed check.
	 */
	async checkImageExists(
		image: string,
		tag: string,
		registryUrl?: string | null,
		auth?: RegistryAuth,
	): Promise<{ exists: boolean; checked: boolean }> {
		const { host, repo } = parseImageRef(image, registryUrl);
		try {
			const res = await this.#registryFetch(
				`https://${host}/v2/${repo}/manifests/${tag}`,
				{ accept: MANIFEST_ACCEPT, method: "HEAD" },
				auth,
			);
			if (res.status === 404) {
				return { checked: true, exists: false };
			}
			if (res.ok) {
				return { checked: true, exists: true };
			}
			return { checked: false, exists: true };
		} catch (err) {
			logger.warn(`Image existence check failed: ${image}:${tag}`, err);
			return { checked: false, exists: true };
		}
	}

	/**
	 * The digest `image:tag` currently points at in its registry (the
	 * manifest list's for a multi-arch image, the same one Docker records in
	 * an image's RepoDigests), via a manifest HEAD. Null when the tag doesn't
	 * exist or the registry won't say.
	 * @throws on network failure.
	 */
	async resolveDigest(
		image: string,
		tag: string,
		registryUrl?: string | null,
		auth?: RegistryAuth,
	): Promise<string | null> {
		const { host, repo } = parseImageRef(image, registryUrl);
		const res = await this.#registryFetch(
			`https://${host}/v2/${repo}/manifests/${tag}`,
			{ accept: MANIFEST_ACCEPT, method: "HEAD" },
			auth,
		);
		return res.ok ? res.headers.get("docker-content-digest") : null;
	}

	/**
	 * Every tag of `image` in its registry, with the digest each points at
	 * when it's cheap to know. Docker Hub images go through Hub's own API,
	 * which returns digests with the tags, newest first. Any other registry
	 * goes through the v2 `tags/list` endpoint, and only the `digestFor`
	 * tags (at most `DIGEST_LOOKUP_LIMIT` of them) get a manifest HEAD each.
	 * @throws when the registry refuses the listing or can't be reached.
	 */
	async listTags(
		image: string,
		options: {
			auth?: RegistryAuth;
			digestFor?: (tags: string[]) => string[];
			registryUrl?: string | null;
		} = {},
	): Promise<RegistryTag[]> {
		const { host, repo } = parseImageRef(image, options.registryUrl);
		if (host === "registry-1.docker.io" && !options.auth) {
			return this.#listDockerHubTags(repo);
		}
		const names = await this.#listRegistryTags({
			auth: options.auth,
			host,
			repo,
		});
		const wanted = new Set(
			(options.digestFor?.(names) ?? []).slice(0, DIGEST_LOOKUP_LIMIT),
		);
		const digests = new Map<string, string | null>();
		await Promise.all(
			[...wanted].map(async (name) => {
				digests.set(
					name,
					await this.resolveDigest(
						image,
						name,
						options.registryUrl,
						options.auth,
					).catch(() => null),
				);
			}),
		);
		return names.map((name) => ({ digest: digests.get(name) ?? null, name }));
	}

	/** Pages through Docker Hub's tag API from `url`, newest first, up to `DOCKER_HUB_MAX_PAGES` pages. */
	async #listDockerHubTags(
		repo: string,
		url = `${DOCKER_HUB_API}/${repo}/tags?page_size=${DOCKER_HUB_PAGE_SIZE}&ordering=last_updated`,
		page = 0,
	): Promise<RegistryTag[]> {
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`Docker Hub answered ${res.status} listing tags.`);
		}
		const body = (await res.json()) as DockerHubTagPage;
		const tags = body.results.map((result) => ({
			digest: result.digest ?? null,
			name: result.name,
		}));
		if (!body.next || page + 1 >= DOCKER_HUB_MAX_PAGES) {
			return tags;
		}
		return [
			...tags,
			...(await this.#listDockerHubTags(repo, body.next, page + 1)),
		];
	}

	/** Pages through a registry's v2 `tags/list` from `url`, following its `Link` header, up to `REGISTRY_MAX_PAGES` pages. */
	async #listRegistryTags(
		target: { auth?: RegistryAuth; host: string; repo: string },
		url = `https://${target.host}/v2/${target.repo}/tags/list?n=${REGISTRY_PAGE_SIZE}`,
		page = 0,
	): Promise<string[]> {
		const { auth, host } = target;
		const res = await this.#registryFetch(url, { method: "GET" }, auth);
		if (!res.ok) {
			throw new Error(`${host} answered ${res.status} listing tags.`);
		}
		const body = (await res.json()) as { tags?: string[] | null };
		const names = body.tags ?? [];
		const next = res.headers.get("link")?.match(LINK_NEXT_RE)?.[1];
		if (!next || page + 1 >= REGISTRY_MAX_PAGES) {
			return names;
		}
		return [
			...names,
			...(await this.#listRegistryTags(
				target,
				new URL(next, `https://${host}`).toString(),
				page + 1,
			)),
		];
	}
}

export const ApiService = new ApiServiceClass();
