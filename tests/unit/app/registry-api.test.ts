import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { parseImageRef, parseWwwAuthenticate } = await import(
	"../../../src/lib/registry-ref"
);
const { Logger } = await import("../../../src/lib/logger");
const { ApiService } = await import("../../../src/lib/services/api.service");

interface Call {
	headers: Record<string, string>;
	method: string;
	url: string;
}

type Route = (call: Call) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
const calls: Call[] = [];
let route: Route = () => new Response(null, { status: 500 });
const warnings: string[] = [];

beforeEach(() => {
	calls.length = 0;
	warnings.length = 0;
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const call = {
			headers: (init.headers ?? {}) as Record<string, string>,
			method: init.method ?? "GET",
			url: String(input),
		};
		calls.push(call);
		return route(call);
	}) as unknown as typeof fetch;
	stub(Logger.prototype, "warn", (message: string) => {
		warnings.push(message);
	});
});

afterEach(() => {
	globalThis.fetch = realFetch;
	restoreStubs();
});

const challenge = (scope = "repository:team/app:pull") =>
	new Response(null, {
		headers: {
			"www-authenticate": `Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="${scope}"`,
		},
		status: 401,
	});

describe("parseImageRef", () => {
	test("an explicit registry URL keeps the image as the repository", () => {
		expect(parseImageRef("team/app", "https://registry.example.com/")).toEqual({
			host: "registry.example.com",
			repo: "team/app",
		});
	});

	test("a host-looking first segment is the registry", () => {
		expect(parseImageRef("ghcr.io/team/app")).toEqual({
			host: "ghcr.io",
			repo: "team/app",
		});
		expect(parseImageRef("localhost/app")).toEqual({
			host: "localhost",
			repo: "app",
		});
		expect(parseImageRef("registry:5000/app")).toEqual({
			host: "registry:5000",
			repo: "app",
		});
	});

	test("bare and single-namespace names are Docker Hub", () => {
		expect(parseImageRef("nginx")).toEqual({
			host: "registry-1.docker.io",
			repo: "library/nginx",
		});
		expect(parseImageRef("gitea/gitea")).toEqual({
			host: "registry-1.docker.io",
			repo: "gitea/gitea",
		});
	});
});

describe("parseWwwAuthenticate", () => {
	test("reads realm, service and scope, unquoted", () => {
		expect(
			parseWwwAuthenticate(
				'Bearer realm="https://auth.docker.io/token", service="registry.docker.io", scope="repository:library/nginx:pull"',
			),
		).toEqual({
			realm: "https://auth.docker.io/token",
			scope: "repository:library/nginx:pull",
			service: "registry.docker.io",
		});
	});

	test("anything but a Bearer challenge with a realm is null", () => {
		expect(parseWwwAuthenticate('Basic realm="registry"')).toBeNull();
		expect(parseWwwAuthenticate('Bearer service="registry"')).toBeNull();
	});
});

describe("ApiService.checkImageExists", () => {
	test("a found manifest exists, a 404 doesn't", async () => {
		route = (call) =>
			new Response(null, {
				status: call.url.endsWith("/manifests/1.0") ? 200 : 404,
			});
		expect(await ApiService.checkImageExists("nginx", "1.0")).toEqual({
			checked: true,
			exists: true,
		});
		expect(await ApiService.checkImageExists("nginx", "nope")).toEqual({
			checked: true,
			exists: false,
		});
		expect(calls[0]).toMatchObject({
			method: "HEAD",
			url: "https://registry-1.docker.io/v2/library/nginx/manifests/1.0",
		});
		expect(calls[0].headers.Accept).toContain(
			"application/vnd.oci.image.index.v1+json",
		);
	});

	test("fails open on a registry error or a network failure", async () => {
		route = () => new Response(null, { status: 503 });
		expect(await ApiService.checkImageExists("nginx", "1.0")).toEqual({
			checked: false,
			exists: true,
		});
		route = () => {
			throw new Error("connection refused");
		};
		expect(await ApiService.checkImageExists("nginx", "1.0")).toEqual({
			checked: false,
			exists: true,
		});
		expect(warnings).toEqual(["Image existence check failed: nginx:1.0"]);
	});

	test("answers a Bearer challenge with a token fetched with Basic auth", async () => {
		route = (call) => {
			if (call.url.startsWith("https://auth.example.com/token")) {
				return Response.json({ access_token: "tok" });
			}
			return call.headers.Authorization === "Bearer tok"
				? new Response(null, { status: 200 })
				: challenge();
		};
		const result = await ApiService.checkImageExists(
			"team/app",
			"1.0",
			"registry.example.com",
			{ password: "secret", username: "alice" },
		);
		expect(result).toEqual({ checked: true, exists: true });
		const tokenCall = calls[1];
		const tokenUrl = new URL(tokenCall.url);
		expect(tokenUrl.searchParams.get("service")).toBe("registry.example.com");
		expect(tokenUrl.searchParams.get("scope")).toBe("repository:team/app:pull");
		expect(tokenCall.headers.Authorization).toBe(
			`Basic ${Buffer.from("alice:secret").toString("base64")}`,
		);
		expect(calls[2].headers.Authorization).toBe("Bearer tok");
	});

	test("a challenge it can't answer leaves the 401 unchecked", async () => {
		route = (call) =>
			call.url.startsWith("https://auth.example.com")
				? new Response(null, { status: 403 })
				: challenge();
		expect(
			await ApiService.checkImageExists(
				"team/app",
				"1.0",
				"registry.example.com",
			),
		).toEqual({ checked: false, exists: true });
		expect(calls[1].headers.Authorization).toBeUndefined();

		calls.length = 0;
		route = () => new Response(null, { status: 401 });
		expect(
			await ApiService.checkImageExists(
				"team/app",
				"1.0",
				"registry.example.com",
			),
		).toEqual({ checked: false, exists: true });
		expect(calls).toHaveLength(1);

		calls.length = 0;
		route = (call) =>
			call.url.startsWith("https://auth.example.com")
				? Response.json({})
				: challenge();
		expect(
			await ApiService.checkImageExists(
				"team/app",
				"1.0",
				"registry.example.com",
			),
		).toEqual({ checked: false, exists: true });
		expect(calls).toHaveLength(2);
	});
});

describe("ApiService.resolveDigest", () => {
	test("reads the digest header, null when the tag is missing", async () => {
		route = (call) =>
			call.url.endsWith("/manifests/1.0")
				? new Response(null, {
						headers: { "docker-content-digest": "sha256:abc" },
						status: 200,
					})
				: new Response(null, { status: 404 });
		expect(await ApiService.resolveDigest("ghcr.io/team/app", "1.0")).toBe(
			"sha256:abc",
		);
		expect(
			await ApiService.resolveDigest("ghcr.io/team/app", "2.0"),
		).toBeNull();
	});
});

describe("ApiService.listTags", () => {
	test("pages through Docker Hub's own API with digests", async () => {
		route = (call) =>
			call.url.includes("page=2")
				? Response.json({ next: null, results: [{ name: "1.0" }] })
				: Response.json({
						next: "https://hub.docker.com/v2/repositories/library/nginx/tags?page=2",
						results: [{ digest: "sha256:new", name: "latest" }],
					});
		expect(await ApiService.listTags("nginx")).toEqual([
			{ digest: "sha256:new", name: "latest" },
			{ digest: null, name: "1.0" },
		]);
		expect(calls[0].url).toBe(
			"https://hub.docker.com/v2/repositories/library/nginx/tags?page_size=100&ordering=last_updated",
		);
	});

	test("stops after ten Docker Hub pages", async () => {
		route = () =>
			Response.json({
				next: "https://hub.docker.com/v2/repositories/library/nginx/tags?page=next",
				results: [{ name: "x" }],
			});
		expect(await ApiService.listTags("nginx")).toHaveLength(10);
		expect(calls).toHaveLength(10);
	});

	test("a Docker Hub error throws", async () => {
		route = () => new Response(null, { status: 429 });
		await expect(ApiService.listTags("nginx")).rejects.toThrow(
			"Docker Hub answered 429 listing tags.",
		);
	});

	test("follows a v2 registry's Link header and resolves the wanted digests", async () => {
		route = (call) => {
			if (call.url.includes("/tags/list?n=1000")) {
				return Response.json(
					{ tags: ["latest", "1.0"] },
					{
						headers: {
							link: '</v2/team/app/tags/list?last=1.0&n=1000>; rel="next"',
						},
					},
				);
			}
			if (call.url.includes("/tags/list?last=1.0")) {
				return Response.json({ tags: null });
			}
			if (call.url.endsWith("/manifests/1.0")) {
				return new Response(null, {
					headers: { "docker-content-digest": "sha256:one" },
					status: 200,
				});
			}
			throw new Error("network down");
		};
		const asked: string[][] = [];
		const tags = await ApiService.listTags("ghcr.io/team/app", {
			digestFor: (names) => {
				asked.push(names);
				return ["1.0", "latest"];
			},
		});
		expect(asked).toEqual([["latest", "1.0"]]);
		expect(tags).toEqual([
			{ digest: null, name: "latest" },
			{ digest: "sha256:one", name: "1.0" },
		]);
		expect(calls.map((call) => call.url)).toContain(
			"https://ghcr.io/v2/team/app/tags/list?last=1.0&n=1000",
		);
	});

	test("an authenticated Docker Hub image goes through the registry API", async () => {
		route = () => Response.json({ tags: ["1.0"] });
		expect(
			await ApiService.listTags("team/private", {
				auth: { password: "p", username: "u" },
			}),
		).toEqual([{ digest: null, name: "1.0" }]);
		expect(calls[0].url).toBe(
			"https://registry-1.docker.io/v2/team/private/tags/list?n=1000",
		);
	});

	test("a registry refusing the listing throws", async () => {
		route = () => new Response(null, { status: 403 });
		await expect(ApiService.listTags("ghcr.io/team/app")).rejects.toThrow(
			"ghcr.io answered 403 listing tags.",
		);
	});
});

describe("ApiService.fetchImageConfig", () => {
	const config = {
		ExposedPorts: { "8080/tcp": {} },
		Volumes: { "/data": {} },
	};

	test("follows a multi-arch index to this platform's config blob", async () => {
		const arch = process.arch === "x64" ? "amd64" : process.arch;
		route = ({ url }) => {
			if (url.endsWith("/manifests/1.0")) {
				return Response.json({
					manifests: [
						{
							digest: "sha256:att",
							platform: { architecture: "unknown", os: "unknown" },
						},
						{
							digest: "sha256:other",
							platform: { architecture: "s390x", os: "linux" },
						},
						{
							digest: "sha256:mine",
							platform: { architecture: arch, os: "linux" },
						},
					],
				});
			}
			if (url.endsWith("/manifests/sha256:mine")) {
				return Response.json({ config: { digest: "sha256:cfg" } });
			}
			if (url.endsWith("/blobs/sha256:cfg")) {
				return Response.json({ config });
			}
			return new Response(null, { status: 404 });
		};
		expect(
			await ApiService.fetchImageConfig("app", "1.0", "registry.example.com"),
		).toEqual(config);
	});

	test("answers a token challenge and follows a blob redirect without it", async () => {
		route = ({ headers, url }) => {
			if (url.startsWith("https://auth.example.com/token")) {
				return Response.json({ token: "tok" });
			}
			if (url.startsWith("https://cdn.example.com/")) {
				return headers.Authorization
					? new Response(null, { status: 400 })
					: Response.json({ config });
			}
			if (!headers.Authorization) {
				return challenge();
			}
			if (url.endsWith("/manifests/latest")) {
				return Response.json({ config: { digest: "sha256:cfg" } });
			}
			return new Response(null, {
				headers: { location: "https://cdn.example.com/blob" },
				status: 307,
			});
		};
		expect(
			await ApiService.fetchImageConfig(
				"team/app",
				"latest",
				"registry.example.com",
			),
		).toEqual(config);
	});

	test("null when the tag, its config or the blob is missing", async () => {
		route = () => new Response(null, { status: 404 });
		expect(
			await ApiService.fetchImageConfig("app", "nope", "registry.example.com"),
		).toBeNull();
		route = ({ url }) =>
			url.includes("/manifests/")
				? Response.json({ config: { digest: "sha256:cfg" } })
				: new Response(null, { status: 500 });
		expect(
			await ApiService.fetchImageConfig("app", "1.0", "registry.example.com"),
		).toBeNull();
		route = () => Response.json({ schemaVersion: 2 });
		expect(
			await ApiService.fetchImageConfig("app", "1.0", "registry.example.com"),
		).toBeNull();
	});
});
