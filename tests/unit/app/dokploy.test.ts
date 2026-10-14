import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { DokployService } = await import(
	"../../../src/lib/services/dokploy.service"
);
const { dokployApplication, dokployCompose, dokployDatabase, dokployRefs } =
	await import("../../../src/lib/migrate/dokploy");
const { interpolate, parseEnvBlob, previewEntries } = await import(
	"../../../src/lib/migrate/common"
);

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

const PROJECT_ALL = [
	{
		createdAt: "2026-09-11T17:44:20.934Z",
		description: "",
		env: "",
		environments: [
			{
				applications: [
					{
						applicationId: "app-img",
						applicationStatus: "done",
						name: "Pocket ID",
					},
				],
				compose: [
					{ composeId: "cmp-1", composeStatus: "done", name: "syncthing" },
				],
				environmentId: "env-1",
				isDefault: true,
				libsql: [],
				mariadb: [],
				mongo: [],
				mysql: [],
				name: "production",
				postgres: [{ postgresId: "pg-1" }],
				redis: [],
			},
		],
		name: "Homelab",
		organizationId: "org-1",
		projectId: "proj-1",
		projectTags: [],
	},
];

const IMAGE_APP = {
	applicationId: "app-img",
	buildType: "nixpacks",
	command: null,
	dockerImage: "ghcr.io/pocket-id/pocket-id:v2",
	domains: [{ host: "auth.example.com", https: true, path: "/", port: 1411 }],
	env: 'APP_URL=https://auth.example.com\nTRUST_PROXY="true"',
	memoryLimit: null,
	mounts: [
		{
			hostPath: null,
			mountPath: "/app/data",
			type: "volume",
			volumeName: "pocket-id_data",
		},
		{
			hostPath: "/etc/localtime",
			mountPath: "/etc/localtime:ro",
			type: "bind",
			volumeName: null,
		},
	],
	name: "Pocket ID",
	ports: [],
	sourceType: "docker",
};

const GITHUB_APP = {
	applicationId: "app-git",
	branch: "main",
	buildPath: "/",
	buildType: "dockerfile",
	dockerContextPath: "",
	dockerImage: null,
	dockerfile: "./Dockerfile",
	domains: [{ host: "example.fr", port: 3000 }],
	env: "TOKEN=abc",
	github: { githubUrl: "https://github.com" },
	mounts: [],
	name: "sergios",
	owner: "acme",
	repository: "sergios",
	sourceType: "github",
};

const COMPOSE = {
	composeFile:
		"services:\n  syncthing:\n    image: lscr.io/linuxserver/syncthing:\u0024{TAG:-latest}\n    expose:\n      - 8384\n",
	composeId: "cmp-1",
	domains: [{ host: "sync.example.com", port: 8384, serviceName: "syncthing" }],
	env: "",
	name: "syncthing",
	sourceType: "raw",
};

const POSTGRES = {
	appName: "gitea-database-gvwqvz",
	databaseName: "gitea",
	databasePassword: "pw",
	databaseUser: "postgres",
	dockerImage: "postgres:17",
	env: null,
	externalPort: null,
	mounts: [
		{
			mountPath: "/var/lib/postgresql/data",
			type: "volume",
			volumeName: "gitea_postgres_data",
		},
	],
	name: "database",
	postgresId: "pg-1",
};

describe("dokployRefs", () => {
	test("walks project.all's environments, where the resources actually live", () => {
		expect(dokployRefs(PROJECT_ALL)).toEqual([
			{
				id: "app-img",
				name: "Pocket ID",
				projectName: "Homelab",
				type: "application",
			},
			{
				id: "cmp-1",
				name: "syncthing",
				projectName: "Homelab",
				type: "compose",
			},
			{ id: "pg-1", name: null, projectName: "Homelab", type: "postgres" },
		]);
	});

	test("still reads an older flat project with no environments", () => {
		expect(
			dokployRefs([{ applications: [{ applicationId: "a" }], name: "Old" }]),
		).toEqual([
			{ id: "a", name: null, projectName: "Old", type: "application" },
		]);
	});
});

describe("dokployApplication", () => {
	test("keeps a domain's path, its strip flag, and warns about an internal path", () => {
		const entry = dokployApplication(
			{
				...IMAGE_APP,
				domains: [
					{
						host: "www.example.com",
						path: "/api",
						port: 3000,
						stripPath: true,
					},
					{
						host: "www.example.com",
						internalPath: "/v1",
						path: "/legacy/",
						port: 3000,
					},
				],
			},
			"Auth",
		);
		expect(entry.drafts[0]).toMatchObject({
			domains: ["www.example.com/api", "www.example.com/legacy"],
			stripPathDomains: ["www.example.com/api"],
		});
		expect(entry.warnings).toContain(
			"www.example.com/legacy forwards to the internal path /v1 on Dokploy, which isn't carried over : serve the app under that path itself.",
		);
	});

	test("maps a docker-image app with its domain port, env and mounts", () => {
		const entry = dokployApplication(IMAGE_APP, "Auth");
		expect(entry.blocked).toBeNull();
		expect(entry.drafts).toHaveLength(1);
		expect(entry.drafts[0]).toMatchObject({
			build: null,
			containerPort: 1411,
			dnsResolvable: true,
			domains: ["auth.example.com"],
			envVars: { APP_URL: "https://auth.example.com", TRUST_PROXY: "true" },
			image: "ghcr.io/pocket-id/pocket-id",
			slug: "pocket-id",
			tag: "v2",
			volumes: [
				{
					containerPath: "/app/data",
					kind: "volume",
					name: "pocket-id_data",
					readOnly: false,
					source: "pocket-id_data",
				},
				{
					containerPath: "/etc/localtime",
					kind: "bind",
					readOnly: true,
					source: "/etc/localtime",
				},
			],
		});
	});

	test("maps a GitHub Dockerfile app onto a git build", () => {
		const entry = dokployApplication(GITHUB_APP, "Sergios");
		expect(entry.blocked).toBeNull();
		expect(entry.drafts[0]?.build).toEqual({
			context: null,
			dockerfile: "Dockerfile",
			gitRef: "main",
			gitUrl: "https://github.com/acme/sergios",
			method: "dockerfile",
		});
		expect(entry.drafts[0]?.containerPort).toBe(3000);
	});

	test("reads a Gitea app's host from the nested provider", () => {
		const entry = dokployApplication(
			{
				...GITHUB_APP,
				gitea: { giteaUrl: "https://git.example.com/" },
				giteaBranch: "dev",
				giteaBuildPath: "/api",
				giteaOwner: "me",
				giteaRepository: "vortex",
				sourceType: "gitea",
			},
			"Stremio",
		);
		expect(entry.drafts[0]?.build).toMatchObject({
			context: "api",
			gitRef: "dev",
			gitUrl: "https://git.example.com/me/vortex",
		});
	});

	test("carries nixpacks, railpack and buildpacks apps over with their builder", () => {
		const cases = [
			["nixpacks", "nixpacks"],
			["railpack", "railpack"],
			["heroku_buildpacks", "heroku"],
			["paketo_buildpacks", "paketo"],
		] as const;
		for (const [buildType, method] of cases) {
			const entry = dokployApplication(
				{ ...GITHUB_APP, buildPath: "/web", buildType },
				"Homelab",
			);
			expect(entry.blocked).toBeNull();
			expect(entry.drafts[0]?.build).toEqual({
				context: "web",
				dockerfile: null,
				gitRef: "main",
				gitUrl: "https://github.com/acme/sergios",
				method,
			});
		}
	});

	test("warns when a Heroku app used an older stack", () => {
		const entry = dokployApplication(
			{ ...GITHUB_APP, buildType: "heroku_buildpacks", herokuVersion: "22" },
			"Homelab",
		);
		expect(entry.warnings.join(" ")).toContain("heroku/builder:22");
	});

	test("blocks a build pack Homerun can't run", () => {
		const entry = dokployApplication(
			{ ...GITHUB_APP, buildType: "static" },
			"Homelab",
		);
		expect(entry.blocked).toContain("static");
		expect(entry.drafts).toEqual([]);
	});
});

describe("dokploy runtime carry-over", () => {
	test("carries private registry credentials over", () => {
		const entry = dokployApplication(
			{
				...IMAGE_APP,
				password: "hunter2",
				registryUrl: "registry.example.com",
				username: "deploy",
			},
			"Auth",
		);
		expect(entry.drafts[0]?.registry).toEqual({
			password: "hunter2",
			url: "registry.example.com",
			username: "deploy",
		});
		expect(entry.warnings.join(" ")).not.toContain("registry");
		expect(
			dokployApplication(IMAGE_APP, "Auth").drafts[0]?.registry,
		).toBeNull();
	});

	test("warns when the registry password didn't come back", () => {
		const entry = dokployApplication(
			{ ...IMAGE_APP, password: null, username: "deploy" },
			"Auth",
		);
		expect(entry.drafts[0]?.registry?.password).toBeNull();
		expect(entry.warnings.join(" ")).toContain("registry password");
	});

	test("runs a custom command through /bin/sh -c, args replacing the arguments", () => {
		const shell = dokployApplication(
			{ ...IMAGE_APP, command: "node server.js --port 1411" },
			"Auth",
		).drafts[0];
		expect(shell?.entrypoint).toEqual(["/bin/sh"]);
		expect(shell?.command).toEqual(["-c", "node server.js --port 1411"]);
		const args = dokployApplication(
			{ ...IMAGE_APP, args: ["--verbose"] },
			"Auth",
		).drafts[0];
		expect(args?.entrypoint).toBeNull();
		expect(args?.command).toEqual(["--verbose"]);
	});

	test("carries file mounts over with their content", () => {
		const entry = dokployApplication(
			{
				...IMAGE_APP,
				mounts: [
					...IMAGE_APP.mounts,
					{
						content: "key: value\n",
						filePath: "config.yml",
						mountPath: "/app/config.yml",
						type: "file",
					},
				],
			},
			"Auth",
		);
		expect(entry.drafts[0]?.files).toEqual([
			{ containerPath: "/app/config.yml", content: "key: value\n" },
		]);
		expect(entry.drafts[0]?.volumes).toHaveLength(2);
		expect(entry.warnings.join(" ")).not.toContain("file mount");
	});

	test("a stack's ../files binds become file drafts, and .env resolves env_file", () => {
		const entry = dokployCompose(
			{
				...COMPOSE,
				composeFile:
					"services:\n  syncthing:\n    image: syncthing/syncthing\n    env_file: .env\n    volumes:\n      - ../files/syncthing.xml:/config/config.xml\n",
				env: "PUID=1000",
				mounts: [
					{
						content: "<configuration/>",
						filePath: "syncthing.xml",
						mountPath: "/config/config.xml",
						type: "file",
					},
				],
			},
			"Homelab",
		);
		expect(entry.drafts[0]?.files).toEqual([
			{ containerPath: "/config/config.xml", content: "<configuration/>" },
		]);
		expect(entry.drafts[0]?.envVars).toEqual({ PUID: "1000" });
		expect(entry.warnings.join(" ")).not.toContain("relative bind");
		expect(entry.warnings.join(" ")).not.toContain("env_file");
	});

	test("applies the Redis password through the start command, like Dokploy", () => {
		const entry = dokployDatabase(
			{
				appName: "cache",
				databasePassword: "p'w",
				dockerImage: "redis:7",
				mounts: [],
				name: "cache",
				redisId: "r-1",
			},
			"redis",
			"Cache",
		);
		expect(entry.drafts[0]?.entrypoint).toEqual(["/bin/sh"]);
		expect(entry.drafts[0]?.command).toEqual([
			"-c",
			"exec redis-server --requirepass 'p'\"'\"'w'",
		]);
		expect(entry.warnings.join(" ")).not.toContain("requirepass");
	});
});

describe("dokployCompose", () => {
	test("parses the stored file and applies Dokploy's domain to its service", () => {
		const entry = dokployCompose(COMPOSE, "Homelab");
		expect(entry.blocked).toBeNull();
		expect(entry.drafts[0]).toMatchObject({
			containerPort: 8384,
			dnsResolvable: true,
			domains: ["sync.example.com"],
			image: "lscr.io/linuxserver/syncthing",
			tag: "latest",
		});
	});

	test("prefixes named volumes with the stack's appName, like compose -p does", () => {
		const entry = dokployCompose(
			{
				...COMPOSE,
				appName: "homelab-syncthing-lknss6",
				composeFile:
					"services:\n  syncthing:\n    image: syncthing/syncthing\n    volumes:\n      - syncthing_config:/config\n      - shared:/shared\n      - pinned:/pinned\n      - /srv/local:/local\nvolumes:\n  syncthing_config:\n  shared:\n    external: true\n  pinned:\n    name: my-pinned\n",
			},
			"Homelab",
		);
		const sources = Object.fromEntries(
			(entry.drafts[0]?.volumes ?? []).map((v) => [v.containerPath, v]),
		);
		expect(sources["/config"]?.source).toBe(
			"homelab-syncthing-lknss6_syncthing_config",
		);
		expect(sources["/shared"]?.source).toBe("shared");
		expect(sources["/pinned"]?.source).toBe("my-pinned");
		expect(sources["/local"]?.kind).toBe("bind");
	});

	test("blocks a git-sourced stack with no stored file", () => {
		const entry = dokployCompose(
			{ ...COMPOSE, composeFile: "", sourceType: "github" },
			"Homelab",
		);
		expect(entry.blocked).toContain("no compose file");
	});
});

describe("dokployDatabase", () => {
	test("turns credentials into the image's own env vars, internal only", () => {
		const entry = dokployDatabase(POSTGRES, "postgres", "Gitea");
		expect(entry.kind).toBe("database");
		expect(entry.drafts[0]).toMatchObject({
			containerPort: 5432,
			dnsResolvable: false,
			envVars: {
				POSTGRES_DB: "gitea",
				POSTGRES_PASSWORD: "pw",
				POSTGRES_USER: "postgres",
			},
			image: "postgres",
			tag: "17",
		});
		expect(entry.drafts[0]?.volumes[0]?.source).toBe("gitea_postgres_data");
	});
});

describe("common helpers", () => {
	test("parseEnvBlob reads a .env blob and tolerates junk", () => {
		expect(parseEnvBlob('FOO=bar\n# c\nQ="x y"\nEMPTY=')).toEqual({
			EMPTY: "",
			FOO: "bar",
			Q: "x y",
		});
		expect(parseEnvBlob(null)).toEqual({});
	});

	test("interpolate fills a known var and a default, leaves unknowns", () => {
		expect(interpolate("\u0024{A} \u0024{B:-b} \u0024{C}", { A: "a" })).toBe(
			"a b \u0024{C}",
		);
	});

	test("previewEntries flags taken slugs and never carries env values", () => {
		const preview = previewEntries(
			[dokployApplication(IMAGE_APP, "Auth")],
			new Set(["pocket-id"]),
		);
		expect(preview.projects).toEqual(["Auth"]);
		expect(preview.entries[0]?.services[0]).toEqual({
			envCount: 2,
			name: "Pocket ID",
			port: 1411,
			public: true,
			slug: "pocket-id",
			slugTaken: true,
			volumeCount: 2,
		});
		expect(JSON.stringify(preview)).not.toContain("auth.example.com");
	});
});

describe("DokployService.listEntries", () => {
	function serve(routes: Record<string, unknown>, status = 200) {
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			calls.push(`${url.pathname}${url.search}`);
			const body = routes[url.pathname];
			return new Response(JSON.stringify(body ?? {}), {
				headers: { "content-type": "application/json" },
				status: body === undefined ? 404 : status,
			});
		}) as typeof fetch;
		return calls;
	}

	test("reads project.all then each resource's .one", async () => {
		const calls = serve({
			"/api/application.one": IMAGE_APP,
			"/api/compose.one": COMPOSE,
			"/api/postgres.one": POSTGRES,
			"/api/project.all": PROJECT_ALL,
		});
		const entries = await DokployService.listEntries({
			baseUrl: "https://dokploy.test/",
			token: "t",
		});
		expect(entries.map((e) => [e.kind, e.name])).toEqual([
			["application", "Pocket ID"],
			["compose", "syncthing"],
			["database", "database"],
		]);
		expect(calls).toContain("/api/postgres.one?postgresId=pg-1");
	});

	test("only fetches the picked resources on import", async () => {
		const calls = serve({
			"/api/application.one": IMAGE_APP,
			"/api/project.all": PROJECT_ALL,
		});
		const entries = await DokployService.listEntries(
			{ baseUrl: "https://dokploy.test", token: "t" },
			new Set(["app-img"]),
		);
		expect(entries).toHaveLength(1);
		expect(calls).toEqual([
			"/api/project.all",
			"/api/application.one?applicationId=app-img",
		]);
	});

	test("names the cause on a rejected token", async () => {
		serve({ "/api/project.all": {} }, 401);
		await expect(
			DokployService.listEntries({
				baseUrl: "https://dokploy.test",
				token: "t",
			}),
		).rejects.toThrow("rejected that API token");
	});

	test("says so when the answer isn't a project list at all", async () => {
		serve({ "/api/project.all": { nope: true } });
		await expect(
			DokployService.listEntries({
				baseUrl: "https://dokploy.test",
				token: "t",
			}),
		).rejects.toThrow("didn't look like a project list");
	});
});
