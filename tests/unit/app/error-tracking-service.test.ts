import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	addMapping,
	GenMapping,
	setSourceContent,
	toEncodedMap,
} from "@jridgewell/gen-mapping";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { ErrorTrackingService, MAX_BODY_BYTES } = await import(
	"../../../src/lib/services/error-tracking.service"
);
const { ErrorRetentionScheduler } = await import(
	"../../../src/lib/services/cron/error-retention-scheduler"
);
const { ErrorProjectDTO } = await import(
	"../../../src/lib/dto/error-project-dto"
);
const { ErrorIssueDTO } = await import("../../../src/lib/dto/error-issue-dto");
const { ErrorEventDTO } = await import("../../../src/lib/dto/error-event-dto");
const { ErrorSourceMapDTO } = await import(
	"../../../src/lib/dto/error-source-map-dto"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { NotificationDTO } = await import(
	"../../../src/lib/dto/notification-dto"
);
const { DeploymentDTO } = await import("../../../src/lib/dto/deployment-dto");
const { RepositoryDTO } = await import("../../../src/lib/dto/repository-dto");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { NotificationChannelService } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { config } = await import("../../../src/lib/config");

const restorers: { mockRestore: () => void }[] = [];
const realOrigin = config.auth.origin;

function track<T extends { mockRestore: () => void }>(spy: T): T {
	restorers.push(spy);
	return spy;
}

afterEach(() => {
	config.auth.origin = realOrigin;
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

const PROJECT = {
	createdAt: new Date(),
	enabled: true,
	id: "p1",
	injectEnv: true,
	internalDsn: true,
	projectId: 7,
	publicKey: "secretkey",
	serviceId: "svc-1",
};

function project(overrides: Partial<typeof PROJECT> = {}) {
	const row = { ...PROJECT, ...overrides };
	return {
		enabled: row.enabled,
		projectId: row.projectId,
		publicKey: row.publicKey,
		serviceId: row.serviceId,
		toJSON: () => row,
	} as unknown as Awaited<ReturnType<typeof ErrorProjectDTO.create>>;
}

const EVENT = {
	event_id: "11111111111111111111111111111111",
	exception: {
		values: [
			{
				stacktrace: {
					frames: [
						{ filename: "/app/a.js", function: "f", in_app: true, lineno: 3 },
					],
				},
				type: "Error",
				value: "boom",
			},
		],
	},
};

function envelope(events: unknown[], extra = ""): string {
	const lines = ['{"sent_at":"2026-09-26T00:00:00Z"}'];
	for (const event of events) {
		lines.push('{"type":"event"}', JSON.stringify(event));
	}
	return `${lines.join("\n")}\n${extra}`;
}

function post(
	body: BodyInit,
	headers: Record<string, string> = {},
	path = "/api/7/envelope/",
) {
	const url = new URL(`https://homerun.test${path}`);
	return {
		request: new Request(url, { body, headers, method: "POST" }),
		url,
	};
}

const AUTH = {
	"x-sentry-auth": "Sentry sentry_version=7, sentry_key=secretkey",
};

function stubStore(
	options: {
		created?: boolean;
		regressed?: boolean;
		status?: string;
		count?: number;
	} = {},
) {
	const records: string[] = [];
	track(spyOn(ErrorEventDTO, "exists").mockResolvedValue(false));
	track(
		spyOn(ErrorIssueDTO, "record").mockImplementation(
			async (_serviceId, fingerprint) => {
				records.push(fingerprint);
				return {
					created: options.created ?? true,
					issue: {
						count: options.count ?? 1,
						id: "issue-1",
						status: options.status ?? "unresolved",
						title: "Error: boom",
					} as never,
					regressed: options.regressed ?? false,
				};
			},
		),
	);
	const created = track(spyOn(ErrorEventDTO, "create").mockResolvedValue());
	const pruned = track(spyOn(ErrorEventDTO, "pruneIssue").mockResolvedValue());
	const notified = track(
		spyOn(NotificationDTO, "notify").mockImplementation(() => {}),
	);
	const channel = track(
		spyOn(NotificationChannelService, "notify").mockImplementation(() => {}),
	);
	track(
		spyOn(ServiceDTO, "get").mockResolvedValue({
			id: "svc-1",
			name: "api",
		} as never),
	);
	return { channel, created, notified, pruned, records };
}

describe("ingest", () => {
	test("stores an envelope's events and notifies on a new issue", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(project()),
		);
		const store = stubStore({ count: 20 });
		const { request, url } = post(
			envelope([EVENT], '{"type":"session"}\n{}\n'),
			AUTH,
		);
		const response = await ErrorTrackingService.ingest(
			request,
			url,
			"7",
			"envelope",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: EVENT.event_id });
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(store.created).toHaveBeenCalledTimes(1);
		expect(store.pruned).toHaveBeenCalledWith("issue-1", 100);
		await Bun.sleep(5);
		expect(store.notified).toHaveBeenCalledTimes(1);
		expect(store.channel).toHaveBeenCalledTimes(1);
	});

	test("accepts gzip on the store endpoint with the key in the query", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(
				project({ projectId: 8, serviceId: "svc-8" }),
			),
		);
		const store = stubStore({ created: false, regressed: false });
		const { request, url } = post(
			gzipSync(
				JSON.stringify({
					...EVENT,
					event_id: "22222222222222222222222222222222",
				}),
			),
			{ "content-encoding": "gzip" },
			"/api/8/store/?sentry_key=secretkey",
		);
		const response = await ErrorTrackingService.ingest(
			request,
			url,
			"8",
			"store",
		);
		expect(response.status).toBe(200);
		expect(store.records).toHaveLength(1);
		expect(store.notified).not.toHaveBeenCalled();
	});

	test("skips a duplicate event and events that aren't objects", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(
				project({ projectId: 9 }),
			),
		);
		const store = stubStore();
		const exists = track(
			spyOn(ErrorEventDTO, "exists").mockResolvedValue(true),
		);
		const { request, url } = post(envelope([EVENT, "nope"]), AUTH);
		const response = await ErrorTrackingService.ingest(
			request,
			url,
			"9",
			"envelope",
		);
		expect(response.status).toBe(200);
		expect(exists).toHaveBeenCalledTimes(1);
		expect(store.records).toHaveLength(0);
	});

	test("an ignored issue never notifies, and a regressed one does", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(
				project({ projectId: 10, serviceId: "svc-10" }),
			),
		);
		let store = stubStore({
			created: false,
			regressed: true,
			status: "ignored",
		});
		await ErrorTrackingService.ingest(
			post(envelope([EVENT]), AUTH).request,
			new URL("https://h/api/10/envelope/"),
			"10",
			"envelope",
		);
		await Bun.sleep(5);
		expect(store.notified).not.toHaveBeenCalled();
		for (const spy of restorers.splice(1)) {
			spy.mockRestore();
		}
		store = stubStore({ created: false, regressed: true });
		await ErrorTrackingService.ingest(
			post(envelope([EVENT]), AUTH).request,
			new URL("https://h/api/10/envelope/"),
			"10",
			"envelope",
		);
		await Bun.sleep(5);
		expect(store.notified).toHaveBeenCalledTimes(1);
	});

	test("caps notifications per service per hour", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(
				project({ projectId: 11, serviceId: "svc-cap" }),
			),
		);
		const store = stubStore();
		for (let index = 0; index < 12; index += 1) {
			const { request, url } = post(
				envelope([EVENT]),
				AUTH,
				"/api/11/envelope/",
			);
			// oxlint-disable-next-line no-await-in-loop -- sequential sends
			await ErrorTrackingService.ingest(request, url, "11", "envelope");
		}
		await Bun.sleep(10);
		expect(store.notified).toHaveBeenCalledTimes(10);

		for (const spy of restorers.splice(1)) {
			spy.mockRestore();
		}
		const regression = stubStore({ created: false, regressed: true });
		const { request, url } = post(envelope([EVENT]), AUTH, "/api/11/envelope/");
		await ErrorTrackingService.ingest(request, url, "11", "envelope");
		await Bun.sleep(10);
		expect(regression.notified).toHaveBeenCalledTimes(1);
	});

	test("refuses bad projects, keys and bodies with Sentry's status codes", async () => {
		const lookup = track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(null),
		);
		const call = async (
			body: BodyInit,
			headers: Record<string, string>,
			id = "7",
		) => {
			const { request, url } = post(body, headers);
			return (await ErrorTrackingService.ingest(request, url, id, "envelope"))
				.status;
		};
		expect(await call(envelope([EVENT]), AUTH, "x")).toBe(404);
		expect(await call(envelope([EVENT]), AUTH)).toBe(404);
		expect(await call(envelope([EVENT]), {})).toBe(401);
		expect(await call("garbage", AUTH)).toBe(400);
		expect(await call("x", { ...AUTH, "content-encoding": "gzip" })).toBe(400);
		expect(await call(new Uint8Array(MAX_BODY_BYTES + 10), AUTH)).toBe(413);
		lookup.mockResolvedValue(project({ publicKey: "other" }));
		expect(await call(envelope([EVENT]), AUTH)).toBe(403);
		lookup.mockResolvedValue(project({ enabled: false }));
		const { request, url } = post(envelope([EVENT]), AUTH);
		const refused = await ErrorTrackingService.ingest(
			request,
			url,
			"7",
			"envelope",
		);
		expect(refused.status).toBe(403);
		expect(refused.headers.get("x-sentry-error")).toBe("project disabled");
		lookup.mockResolvedValue(project());
		expect(await call(envelope([]), AUTH)).toBe(200);
	});

	test("rate-limits a project with Retry-After and X-Sentry-Rate-Limits", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(
				project({ projectId: 12 }),
			),
		);
		stubStore({ created: false });
		let last: Response | null = null;
		for (let index = 0; index < 121; index += 1) {
			const { request, url } = post(
				envelope([EVENT]),
				AUTH,
				"/api/12/envelope/",
			);
			// oxlint-disable-next-line no-await-in-loop -- sequential sends
			last = await ErrorTrackingService.ingest(request, url, "12", "envelope");
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
		expect(last?.headers.get("x-sentry-rate-limits")).toMatch(/^\d+::key$/);
	});

	test("preflight allows browser SDKs", () => {
		const response = ErrorTrackingService.preflight();
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"x-sentry-auth",
		);
	});
});

describe("deploy env and DSNs", () => {
	const service = {
		buildSource: "git",
		channelCanary: false,
		envVars: {},
		environmentName: null,
		gitBuildContext: null,
		gitUrl: "https://github.com/me/app.git",
		id: "svc-1",
		previewParentId: null,
	} as never;

	test("injects the internal DSN when the dashboard runs on the network", async () => {
		config.auth.origin = "https://dash.test";
		track(spyOn(ErrorProjectDTO, "getForService").mockResolvedValue(project()));
		track(
			spyOn(DockerService, "selfContainer").mockResolvedValue({
				aliases: ["homerun-auth"],
				labels: {},
				name: "homerun",
				networkAddress: null,
			}),
		);
		const env = await ErrorTrackingService.deployEnv(service, null);
		expect(env?.releaseFromBuild).toBe(true);
		expect(env?.env[0][1]).toMatch(/^http:\/\/secretkey@homerun-auth:\d+\/7$/);
		const dsns = await ErrorTrackingService.dsns({
			projectId: 7,
			publicKey: "k",
		});
		expect(dsns.public).toBe("https://k@dash.test/7");
	});

	test("injects nothing when tracking or injection is off", async () => {
		const lookup = track(
			spyOn(ErrorProjectDTO, "getForService").mockResolvedValue(null),
		);
		expect(await ErrorTrackingService.deployEnv(service, null)).toBeNull();
		lookup.mockResolvedValue(project({ injectEnv: false }));
		expect(await ErrorTrackingService.deployEnv(service, null)).toBeNull();
	});

	test("links sources at the release commit or the deployment at event time", async () => {
		track(
			spyOn(InstanceSettingsDTO, "get").mockResolvedValue({
				gitProviders: [],
			} as never),
		);
		const commitAt = track(
			spyOn(DeploymentDTO, "commitAt").mockResolvedValue("def5678"),
		);
		expect(
			await ErrorTrackingService.sourceRepo(service, {
				release: "abc1234",
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toEqual({
			buildContext: null,
			commit: "abc1234",
			provider: "github",
			repoUrl: "https://github.com/me/app",
		});
		expect(
			(
				await ErrorTrackingService.sourceRepo(service, {
					release: "v1",
					timestamp: "2026-09-26T00:00:00Z",
				})
			)?.commit,
		).toBe("def5678");
		commitAt.mockResolvedValue(null);
		expect(
			await ErrorTrackingService.sourceRepo(service, {
				release: null,
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toBeNull();
		expect(
			await ErrorTrackingService.sourceRepo({ buildSource: "image" } as never, {
				release: null,
				timestamp: "",
			}),
		).toBeNull();
		expect(
			await ErrorTrackingService.sourceRepo(
				{ buildSource: "git", gitUrl: "nope" } as never,
				{ release: null, timestamp: "" },
			),
		).toBeNull();
	});
});

describe("linked repository", () => {
	const repo = {
		providerKind: "gitea",
		toJSON: () => ({ defaultBranch: "main" }),
		webUrl: "https://git.test/acme/api",
	};

	test("links an image service's frames to its linked repository, at the release or its default branch", async () => {
		const get = track(
			spyOn(RepositoryDTO, "get").mockResolvedValue(repo as never),
		);
		const image = { buildSource: "image", repositoryId: "repo-1" } as never;
		expect(
			await ErrorTrackingService.sourceRepo(image, {
				release: "abc1234def",
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toEqual({
			branch: false,
			buildContext: null,
			commit: "abc1234def",
			provider: "gitea",
			repoUrl: "https://git.test/acme/api",
		});
		expect(
			await ErrorTrackingService.sourceRepo(image, {
				release: "v2",
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toMatchObject({ branch: true, commit: "main" });
		expect(get).toHaveBeenCalledWith("repo-1");
	});

	test("prefers the deployed commit for a git service and needs some ref", async () => {
		track(
			spyOn(RepositoryDTO, "get").mockResolvedValue({
				...repo,
				toJSON: () => ({ defaultBranch: null }),
			} as never),
		);
		const commitAt = track(
			spyOn(DeploymentDTO, "commitAt").mockResolvedValue("def5678"),
		);
		const git = {
			buildSource: "git",
			gitBuildContext: "web",
			id: "svc-1",
			repositoryId: "repo-1",
		} as never;
		expect(
			await ErrorTrackingService.sourceRepo(git, {
				release: null,
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toMatchObject({ branch: false, buildContext: "web", commit: "def5678" });
		commitAt.mockResolvedValue(null);
		expect(
			await ErrorTrackingService.sourceRepo(git, {
				release: null,
				timestamp: "2026-09-26T00:00:00Z",
			}),
		).toBeNull();
	});
});

describe("retention", () => {
	test("prunes events and closed issues past the window, hourly", async () => {
		const events = track(
			spyOn(ErrorEventDTO, "pruneOlderThan").mockResolvedValue(),
		);
		const issues = track(
			spyOn(ErrorIssueDTO, "pruneClosed").mockResolvedValue(),
		);
		const scheduler = new ErrorRetentionScheduler() as unknown as {
			tick(): Promise<void>;
		};
		await scheduler.tick();
		const cutoff = events.mock.calls[0][0] as Date;
		expect(Date.now() - cutoff.getTime()).toBeGreaterThan(
			29 * 24 * 60 * 60 * 1000,
		);
		expect(issues).toHaveBeenCalledWith(cutoff);
	});
});

describe("ingest with source maps", () => {
	const generated = new GenMapping({ file: "app.js" });
	setSourceContent(
		generated,
		"webpack://app/./src/lib/math.ts",
		"export function add(a, b) {\n  return a.b + b;\n}",
	);
	addMapping(generated, {
		generated: { column: 42, line: 1 },
		name: "add",
		original: { column: 9, line: 2 },
		source: "webpack://app/./src/lib/math.ts",
	});
	const MAP = JSON.stringify(toEncodedMap(generated));
	const BROWSER_EVENT = {
		event_id: "22222222222222222222222222222222",
		exception: {
			values: [
				{
					stacktrace: {
						frames: [
							{
								abs_path: "https://app.example.com/_app/app.js",
								colno: 43,
								filename: "/_app/app.js",
								function: "t",
								in_app: true,
								lineno: 1,
							},
						],
					},
					type: "TypeError",
					value: "a is undefined",
				},
			],
		},
		release: "abc123",
	};

	test("maps a release's minified frames back to source before storing, caching the parsed map", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(project()),
		);
		stubStore();
		const stored = track(spyOn(ErrorEventDTO, "create").mockResolvedValue());
		track(
			spyOn(ErrorSourceMapDTO, "namesFor").mockResolvedValue([
				{ id: "map-cached", name: "_app/app.js" },
			]),
		);
		const content = track(
			spyOn(ErrorSourceMapDTO, "content").mockResolvedValue(MAP),
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			const { request, url } = post(
				envelope([{ ...BROWSER_EVENT, event_id: `${attempt}`.repeat(32) }]),
				AUTH,
			);
			expect(
				(await ErrorTrackingService.ingest(request, url, "7", "envelope"))
					.status,
			).toBe(200);
		}
		const event = stored.mock.calls[0]?.[2] as {
			culprit: string;
			exceptions: { frames: { function: string; lineno: number }[] }[];
		};
		expect(event.exceptions[0]?.frames[0]).toMatchObject({
			function: "add",
			lineno: 2,
		});
		expect(event.culprit).toBe("add (src/lib/math.ts)");
		expect(content).toHaveBeenCalledTimes(1);
	});

	test("skips a map that doesn't parse and stores the frames as sent", async () => {
		track(
			spyOn(ErrorProjectDTO, "getByProjectId").mockResolvedValue(project()),
		);
		stubStore();
		const stored = track(spyOn(ErrorEventDTO, "create").mockResolvedValue());
		track(
			spyOn(ErrorSourceMapDTO, "namesFor").mockResolvedValue([
				{ id: "map-broken", name: "_app/app.js" },
			]),
		);
		track(spyOn(ErrorSourceMapDTO, "content").mockResolvedValue("not json"));
		const { request, url } = post(
			envelope([{ ...BROWSER_EVENT, event_id: "3".repeat(32) }]),
			AUTH,
		);
		await ErrorTrackingService.ingest(request, url, "7", "envelope");
		const event = stored.mock.calls[0]?.[2] as {
			exceptions: { frames: { function: string }[] }[];
		};
		expect(event.exceptions[0]?.frames[0]?.function).toBe("t");
	});
});
