import {
	afterAll,
	afterEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

class FakeSettingsError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const save = mock(
	async (
		_svc: unknown,
		_input: Record<string, unknown>,
		_actor: Record<string, unknown>,
	): Promise<unknown> => ({ filteredOut: 0, redeploying: false }),
);
const resolveGitCredential = mock(async () => ({
	token: "t",
	username: "u",
}));

mock.module("#lib/services/service-settings.service.js", () => ({
	ServiceSettingsService: { save },
}));
mock.module("../../../src/lib/services/service-settings.service.ts", () => ({
	ServiceSettingsService: { save },
}));
const helpers = await import("../../../src/lib/services/deploy/helpers");
mock.module("../../../src/lib/services/deploy/helpers.ts", () => ({
	...helpers,
	resolveGitCredential,
}));

const { WorkerClient } = await import("../../../src/lib/server/worker-client");
const post = spyOn(WorkerClient, "post").mockImplementation((async () => ({
	commit: "",
	content: "",
	path: "",
})) as unknown as typeof WorkerClient.post);

const { ManifestError, ManifestService, manifestScopeFor } = await import(
	"../../../src/lib/services/manifest.service"
);

type Service = Parameters<typeof ManifestService.apply>[0];

function service(row: Record<string, unknown>): Service {
	return {
		buildSource: row.buildSource ?? "image",
		toJSON: () => ({ envVars: {}, gitBuildContext: null, ...row }),
	} as unknown as Service;
}

afterEach(() => {
	save.mockClear();
	post.mockClear();
});

afterAll(() => {
	post.mockRestore();
});

describe("manifestScopeFor", () => {
	test("previews and canaries only take build and runtime keys", () => {
		expect(
			manifestScopeFor({ channelCanary: false, previewParentId: null }),
		).toBe("full");
		expect(
			manifestScopeFor({ channelCanary: false, previewParentId: "parent" }),
		).toBe("build-runtime");
		expect(
			manifestScopeFor({ channelCanary: true, previewParentId: null }),
		).toBe("build-runtime");
	});
});

describe("ManifestService.apply", () => {
	test("merges the environment and never grants host access", async () => {
		const result = await ManifestService.apply(
			service({ envVars: { KEPT: "1", SHARED: "old" } }),
			{ containerPort: 3000, envVars: { SHARED: "new" } },
			"full",
			{ userId: "u1" },
		);
		expect(result).toEqual({
			applied: ["containerPort", "envVars"],
			ignored: [],
		});
		const [, input, actor] = save.mock.calls[0] ?? [];
		expect(input).toEqual({
			containerPort: 3000,
			envVars: { KEPT: "1", SHARED: "new" },
		});
		expect(actor).toEqual({ hostAccess: false, userId: "u1" });
	});

	test("leaves the environment alone when the manifest has none", async () => {
		await ManifestService.apply(
			service({ buildSource: "git" }),
			{ containerPort: 80, image: "nginx" },
			"full",
			{ deploying: true, userId: "u1" },
		);
		const [, input, actor] = save.mock.calls[0] ?? [];
		expect(input).toEqual({ containerPort: 80 });
		expect(actor).toEqual({
			deploying: true,
			hostAccess: false,
			userId: "u1",
		});
	});

	test("turns a refusal into a ManifestError with its status", async () => {
		save.mockImplementationOnce(
			async () => new FakeSettingsError("That's not enabled.", 403),
		);
		const refused = ManifestService.apply(
			service({}),
			{ authRequired: true },
			"full",
			{ userId: "u1" },
		);
		await expect(refused).rejects.toBeInstanceOf(ManifestError);
		await expect(refused).rejects.toMatchObject({
			message: "That's not enabled.",
			status: 403,
		});
	});
});

describe("ManifestService.readFromRepo", () => {
	const repoService = service({
		buildSource: "git",
		gitBuildContext: "apps/web",
		gitUrl: "https://git.example.com/app.git",
	});

	test("asks the worker for the nearest manifest with the build's credential", async () => {
		post.mockImplementationOnce((async () => ({
			commit: "abc123",
			content: "containerPort: 8080\n",
			path: "apps/web/.homerun.yaml",
		})) as unknown as typeof WorkerClient.post);
		expect(
			await ManifestService.readFromRepo(repoService, "main", "u1"),
		).toEqual({
			commit: "abc123",
			manifest: { containerPort: 8080 },
			path: "apps/web/.homerun.yaml",
		});
		const [path, body] = (post.mock.calls[0] ?? []) as [
			string,
			Record<string, unknown>,
		];
		expect(path).toBe("/v1/git/file");
		expect(body).toMatchObject({
			credential: { token: "t", username: "u" },
			ref: "main",
			url: "https://git.example.com/app.git",
		});
		expect(body.paths).toEqual(
			expect.arrayContaining(["apps/web/.homerun.json"]),
		);
	});

	test("is null without a manifest or without a repository", async () => {
		expect(
			await ManifestService.readFromRepo(repoService, "main", "u1"),
		).toBeNull();
		expect(
			await ManifestService.readFromRepo(
				service({ gitUrl: null }),
				"main",
				"u1",
			),
		).toBeNull();
	});

	test("fails on an invalid manifest or an unreadable repository", async () => {
		post.mockImplementationOnce((async () => ({
			commit: "abc123",
			content: '{"port": 1}',
			path: ".homerun.json",
		})) as unknown as typeof WorkerClient.post);
		await expect(
			ManifestService.readFromRepo(repoService, "main", "u1"),
		).rejects.toThrow(".homerun.json isn't a valid Homerun Manifest");
		post.mockImplementationOnce((async () => {
			throw new Error("clone failed");
		}) as unknown as typeof WorkerClient.post);
		await expect(
			ManifestService.readFromRepo(repoService, "main", "u1"),
		).rejects.toThrow(
			"Couldn't look for a manifest in the repository: clone failed",
		);
	});
});
