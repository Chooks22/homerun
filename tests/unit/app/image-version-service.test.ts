import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { Logger } = await import("../../../src/lib/logger");
const { DeploymentDTO } = await import("../../../src/lib/dto/deployment-dto");
const { NotificationDTO } = await import(
	"../../../src/lib/dto/notification-dto"
);
const { WorkerClient, WorkerRequestError } = await import(
	"../../../src/lib/server/worker-client"
);
const { ApiService } = await import("../../../src/lib/services/api.service");
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { NotificationChannelService } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { dockerHealthcheck } = await import(
	"../../../src/lib/services/docker/healthcheck"
);
const { listeningHealthcheck } = await import(
	"../../../src/lib/services/docker/readiness"
);
const { ImageVersionService } = await import(
	"../../../src/lib/services/image-version.service"
);

type Service = Parameters<typeof ImageVersionService.describe>[0];
interface RegistryTag {
	digest: string | null;
	name: string;
}

interface Inspect {
	ExitCode?: number;
	Health?: { Status?: string };
	Running?: boolean;
}

const AUTH = { password: "p", username: "u" };
const NO_TIMING = {
	intervalSeconds: null,
	retries: null,
	startPeriodSeconds: null,
	timeoutSeconds: null,
};

let now = 0;
let registryTags: RegistryTag[] = [];
let registryError: unknown = null;
const remoteDigests = new Map<string, string | null>();
let deployments: Record<string, unknown>[] = [];
let localImage: { digest?: string | null; id: string | null } | null = null;
let imageLabels: Record<string, string> | null = null;
let tagError: unknown = null;
let pullGate: Promise<void> | null = null;
let pullError: unknown = null;
let inspects: (Inspect | null)[] = [];
let logOutput: string | null = null;
const listTagsCalls: { digestsWanted: string[] | null }[] = [];
const resolveCalls: string[] = [];
const workerCalls: unknown[][] = [];
const pulls: unknown[] = [];
const notifications: Record<string, unknown>[] = [];
const channelMessages: unknown[] = [];
const deploys: Record<string, unknown>[] = [];
const warnings: string[] = [];

function fakeService(overrides: Record<string, unknown> = {}) {
	const row: Record<string, unknown> = {
		buildSource: "image",
		command: ["serve"],
		containerPort: 3000,
		entrypoint: null,
		envVars: { A: "1" },
		healthcheckCommand: null,
		healthcheckDisabled: false,
		healthcheckIntervalSeconds: null,
		healthcheckRetries: null,
		healthcheckStartPeriodSeconds: null,
		healthcheckTimeoutSeconds: null,
		id: "s1",
		image: "gitea/gitea",
		name: "Gitea",
		pinnedFromTag: null,
		pinnedLocally: false,
		previewParentId: null,
		pullPolicy: "always",
		registryUrl: null,
		slug: "gitea",
		tag: "1.24.3",
		updateCheck: null,
		updateCheckEnabled: true,
		updateTrialEnabled: false,
		...overrides,
	};
	const updates: Record<string, unknown>[] = [];
	const svc: Record<string, unknown> = {
		toJSON: () => row,
		update: async (patch: Record<string, unknown>) => {
			updates.push(structuredClone(patch));
			Object.assign(row, patch);
		},
	};
	for (const key of [
		"buildSource",
		"command",
		"envVars",
		"id",
		"image",
		"name",
		"registryUrl",
		"slug",
		"tag",
	]) {
		Object.defineProperty(svc, key, { get: () => row[key] });
	}
	return { row, svc: svc as unknown as Service, updates };
}

function deployment(fields: Record<string, unknown>) {
	return { toJSON: () => fields };
}

function deferred() {
	let release = () => undefined as void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function settle(condition: () => boolean) {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
		await Bun.sleep(0);
	}
}

beforeEach(() => {
	now = 1_000_000;
	registryTags = [];
	registryError = null;
	remoteDigests.clear();
	deployments = [];
	localImage = null;
	imageLabels = null;
	tagError = null;
	pullGate = null;
	pullError = null;
	inspects = [{ Health: { Status: "healthy" }, Running: true }];
	logOutput = null;
	for (const list of [
		listTagsCalls,
		resolveCalls,
		workerCalls,
		pulls,
		notifications,
		channelMessages,
		deploys,
		warnings,
	]) {
		list.length = 0;
	}
	stub(Date, "now", () => now);
	stub(globalThis, "setTimeout", (callback: () => void, ms: number) => {
		now += ms;
		queueMicrotask(callback);
		return 0;
	});
	stub(
		ApiService,
		"listTags",
		async (
			_image: string,
			options: { digestFor?: (names: string[]) => string[] },
		) => {
			listTagsCalls.push({
				digestsWanted:
					options.digestFor?.(registryTags.map((tag) => tag.name)) ?? null,
			});
			if (registryError) {
				throw registryError;
			}
			return registryTags;
		},
	);
	stub(ApiService, "resolveDigest", async (_image: string, tag: string) => {
		resolveCalls.push(tag);
		if (registryError) {
			throw registryError;
		}
		return remoteDigests.get(tag) ?? null;
	});
	stub(DeploymentDTO, "listForService", async () =>
		deployments.map(deployment),
	);
	stub(DockerService, "buildAuthConfig", () => AUTH);
	stub(DockerService, "pullImage", async (params: unknown) => {
		pulls.push(params);
		await pullGate;
		if (pullError) {
			throw pullError;
		}
		return { digest: null };
	});
	stub(DockerService, "streamLogs", async () => {
		if (logOutput === null) {
			throw new Error("no logs");
		}
		return new Response(logOutput).body;
	});
	stub(
		WorkerClient,
		"get",
		async (path: string, query?: Record<string, string>) => {
			workerCalls.push(["get", path, query]);
			if (path === "v1/images/id") {
				if (!localImage) {
					throw new WorkerRequestError("gone", 404);
				}
				return localImage;
			}
			if (path === "v1/images/inspect") {
				if (!imageLabels) {
					throw new WorkerRequestError("gone", 404);
				}
				return { Config: { Labels: imageLabels } };
			}
			const state = inspects.length > 1 ? inspects.shift() : inspects[0];
			return state ? { State: state } : {};
		},
	);
	stub(WorkerClient, "post", async (path: string, body?: unknown) => {
		workerCalls.push(["post", path, body]);
		if (path === "v1/images/tag" && tagError) {
			throw tagError;
		}
		return path === "v1/containers" ? { id: "trial-1" } : {};
	});
	stub(
		WorkerClient,
		"delete",
		async (path: string, query?: Record<string, string>) => {
			workerCalls.push(["delete", path, query]);
			return {};
		},
	);
	stub(NotificationDTO, "notify", (input: Record<string, unknown>) => {
		notifications.push(input);
	});
	stub(NotificationChannelService, "notify", (message: unknown) => {
		channelMessages.push(message);
	});
	stub(
		DeploymentService,
		"enqueueDeploy",
		async (input: Record<string, unknown>) => {
			deploys.push(input);
		},
	);
	stub(Logger.prototype, "info", () => undefined);
	stub(Logger.prototype, "warn", (message: string) => {
		warnings.push(message);
	});
});

afterEach(() => {
	restoreStubs();
});

const containerCreate = () =>
	workerCalls.find(
		(call) => call[0] === "post" && call[1] === "v1/containers",
	)?.[2] as { body: Record<string, unknown>; name: string } | undefined;

describe("ImageVersionService.unsupportedReason and describe", () => {
	test("only a service deployed from an image, not its children, has updates", () => {
		expect(
			ImageVersionService.unsupportedReason(
				fakeService({ buildSource: "git" }).svc,
			),
		).toContain("Only a service deployed from an image");
		expect(
			ImageVersionService.unsupportedReason(
				fakeService({ previewParentId: "parent" }).svc,
			),
		).toContain("not on its environments, previews or canary");
		expect(ImageVersionService.unsupportedReason(fakeService().svc)).toBeNull();
	});

	test("flattens the pin and the last check", () => {
		const { svc } = fakeService({
			pinnedFromTag: "latest",
			pinnedLocally: true,
			tag: "1.24.3-dev",
			updateCheck: {
				available: { digest: "sha256:n", foundAt: "t1", tag: "1.24.4" },
				checkedAt: "t2",
				error: null,
				notifiedKey: null,
				trial: { at: "t3", message: "ok", status: "passed", tag: "1.24.4" },
			},
		});
		expect(ImageVersionService.describe(svc)).toEqual({
			availableDigest: "sha256:n",
			availableFoundAt: "t1",
			availableTag: "1.24.4",
			checkedAt: "t2",
			checkError: null,
			id: "s1",
			image: "gitea/gitea",
			pinned: true,
			pinnedFromTag: "latest",
			pinnedLocally: true,
			tag: "1.24.3-dev",
			trialAt: "t3",
			trialMessage: "ok",
			trialStatus: "passed",
			trialTag: "1.24.4",
			updateCheckEnabled: true,
			updateTrialEnabled: false,
		});
		expect(ImageVersionService.describe(fakeService().svc)).toMatchObject({
			availableTag: null,
			checkedAt: null,
			pinned: false,
			trialStatus: null,
		});
	});
});

describe("ImageVersionService.setWatch", () => {
	test("turning the watch off forgets the last check", async () => {
		const { svc, updates } = fakeService({
			updateCheck: { available: null },
			updateTrialEnabled: true,
		});
		await ImageVersionService.setWatch(svc, { updateCheckEnabled: false });
		expect(updates).toEqual([
			{
				updateCheck: null,
				updateCheckEnabled: false,
				updateTrialEnabled: true,
			},
		]);
		expect(listTagsCalls).toEqual([]);
	});

	test("turning it on runs the first check", async () => {
		const { svc, updates } = fakeService({ updateCheckEnabled: false });
		registryTags = [{ digest: "sha256:a", name: "1.24.3" }];
		await ImageVersionService.setWatch(svc, {
			updateCheckEnabled: true,
			updateTrialEnabled: true,
		});
		expect(updates[0]).toEqual({
			updateCheckEnabled: true,
			updateTrialEnabled: true,
		});
		expect(updates[1]).toMatchObject({
			updateCheck: { available: null, error: null },
		});
	});

	test("an existing check isn't rerun when only the trial setting changes", async () => {
		const { svc, updates } = fakeService({
			updateCheck: { available: null, checkedAt: "t" },
		});
		await ImageVersionService.setWatch(svc, { updateTrialEnabled: true });
		expect(updates).toEqual([
			{ updateCheckEnabled: true, updateTrialEnabled: true },
		]);
		expect(listTagsCalls).toEqual([]);
	});
});

describe("ImageVersionService.findPinCandidates", () => {
	test("refuses a service built from git", async () => {
		await expect(
			ImageVersionService.findPinCandidates(
				fakeService({ buildSource: "git" }).svc,
			),
		).rejects.toThrow("Only a service deployed from an image can be pinned.");
	});

	test("matches the live revision's digest, looking up version tags newest first", async () => {
		const { svc } = fakeService({ tag: "latest" });
		deployments = [
			{ imageDigest: "sha256:old", imageId: "old", status: "failed" },
			{ imageDigest: "sha256:a", imageId: "sha256:img", status: "running" },
		];
		imageLabels = { "org.opencontainers.image.version": "1.24.4" };
		registryTags = [
			{ digest: "sha256:a", name: "latest" },
			{ digest: null, name: "1.9.0" },
			{ digest: "sha256:a", name: "1.24.4" },
			{ digest: "sha256:a", name: "1.24" },
			{ digest: "sha256:b", name: "nightly" },
		];
		expect(await ImageVersionService.findPinCandidates(svc)).toEqual({
			digest: "sha256:a",
			matches: ["1.24.4", "1.24"],
			suggestion: "1.24.4",
		});
		expect(listTagsCalls).toEqual([
			{ digestsWanted: ["1.24.4", "1.24", "1.9.0"] },
		]);
		expect(workerCalls[0]).toEqual([
			"get",
			"v1/images/inspect",
			{ ref: "sha256:img" },
		]);
	});

	test("without a digest it offers only a local tag, from the label-schema version", async () => {
		const { svc } = fakeService({ tag: "nightly" });
		localImage = { digest: "", id: "sha256:local" };
		imageLabels = { "org.label-schema.version": "2.0+dev" };
		expect(await ImageVersionService.findPinCandidates(svc)).toEqual({
			digest: null,
			matches: [],
			suggestion: "2.0-dev",
		});
		expect(workerCalls[0]).toEqual([
			"get",
			"v1/images/id",
			{ ref: "gitea/gitea:nightly" },
		]);
		expect(listTagsCalls).toEqual([]);
	});

	test("a registry that can't be listed still offers the local tag", async () => {
		const { svc } = fakeService({ tag: "nightly" });
		localImage = { digest: "sha256:x", id: null };
		registryError = new Error("registry down");
		const candidates = await ImageVersionService.findPinCandidates(svc);
		expect(candidates.digest).toBe("sha256:x");
		expect(candidates.matches).toEqual([]);
		expect(candidates.suggestion).toMatch(/^nightly-\d{8}$/);
		expect(warnings).toEqual([
			"Tag listing failed: service=s1 : registry down",
		]);
	});
});

describe("ImageVersionService.pin and unpin", () => {
	test("refuses an invalid tag", async () => {
		const { svc, updates } = fakeService();
		await expect(
			ImageVersionService.pin(svc, "bad tag", { local: false }),
		).rejects.toThrow("A tag is letters, digits");
		expect(updates).toEqual([]);
	});

	test("a registry tag replaces the floating one, remembering the first floating tag", async () => {
		const { svc, updates } = fakeService({ tag: "latest" });
		await ImageVersionService.pin(svc, "1.24.4", { local: false });
		await ImageVersionService.pin(svc, "1.24.5", { local: false });
		expect(updates).toEqual([
			{
				pinnedFromTag: "latest",
				pinnedLocally: false,
				tag: "1.24.4",
				updateCheck: null,
			},
			{
				pinnedFromTag: "latest",
				pinnedLocally: false,
				tag: "1.24.5",
				updateCheck: null,
			},
		]);
		expect(workerCalls).toEqual([]);
	});

	test("a local tag is made from the running image and stops pulling", async () => {
		const { svc, updates } = fakeService({ tag: "nightly" });
		deployments = [
			{ imageDigest: null, imageId: "sha256:img", status: "running" },
		];
		await ImageVersionService.pin(svc, "nightly-20261014", { local: true });
		expect(workerCalls).toEqual([
			[
				"post",
				"v1/images/tag",
				{
					repository: "gitea/gitea",
					source: "sha256:img",
					tag: "nightly-20261014",
				},
			],
		]);
		expect(updates).toEqual([
			{
				pinnedFromTag: "nightly",
				pinnedLocally: true,
				pullPolicy: "missing",
				tag: "nightly-20261014",
				updateCheck: null,
			},
		]);
	});

	test("a running image that's gone asks for a redeploy, other failures pass through", async () => {
		const { svc, updates } = fakeService({ tag: "nightly" });
		tagError = new WorkerRequestError("No such image", 404);
		await expect(
			ImageVersionService.pin(svc, "local-1", { local: true }),
		).rejects.toThrow("The running image isn't on this host any more");
		expect(workerCalls[1]).toMatchObject([
			"post",
			"v1/images/tag",
			{ source: "gitea/gitea:nightly" },
		]);
		tagError = new WorkerRequestError("daemon down", 500);
		await expect(
			ImageVersionService.pin(svc, "local-1", { local: true }),
		).rejects.toThrow("daemon down");
		expect(updates).toEqual([]);
	});

	test("unpinning goes back to the floating tag, pulling again after a local pin", async () => {
		const local = fakeService({
			pinnedFromTag: "nightly",
			pinnedLocally: true,
			tag: "nightly-1",
		});
		await ImageVersionService.unpin(local.svc);
		expect(local.updates).toEqual([
			{
				pinnedFromTag: null,
				pinnedLocally: false,
				pullPolicy: "always",
				tag: "nightly",
				updateCheck: null,
			},
		]);
		const registry = fakeService({ pinnedFromTag: "latest", tag: "1.24.4" });
		await ImageVersionService.unpin(registry.svc);
		expect(registry.updates[0]).not.toHaveProperty("pullPolicy");
		const unpinned = fakeService();
		await ImageVersionService.unpin(unpinned.svc);
		expect(unpinned.updates).toEqual([]);
	});
});

describe("ImageVersionService.check", () => {
	test("notifies a newer release once, in-app and to the channels", async () => {
		const { row, svc } = fakeService();
		registryTags = [
			{ digest: "sha256:old", name: "1.24.3" },
			{ digest: "sha256:new", name: "1.24.4" },
			{ digest: "sha256:rc", name: "1.25.0-rc1" },
		];
		const first = await ImageVersionService.check(svc);
		expect(first?.available).toMatchObject({
			digest: "sha256:new",
			tag: "1.24.4",
		});
		expect(notifications).toEqual([
			{
				detail: null,
				message: '"Gitea" can update to 1.24.4.',
				serviceId: "s1",
				type: "update_available",
			},
		]);
		expect(channelMessages).toHaveLength(1);
		expect(row.updateCheck).toMatchObject({ notifiedKey: "1.24.4@sha256:new" });
		const foundAt = first?.available?.foundAt;
		now += 60_000;
		const second = await ImageVersionService.check(svc);
		expect(second?.available?.foundAt).toBe(foundAt);
		expect(notifications).toHaveLength(1);
		expect(resolveCalls).toEqual([]);
	});

	test("asks the registry for a newer release's digest when the listing has none", async () => {
		const { svc } = fakeService();
		registryTags = [{ digest: null, name: "1.24.4" }];
		remoteDigests.set("1.24.4", "sha256:resolved");
		const state = await ImageVersionService.check(svc);
		expect(state?.available).toMatchObject({
			digest: "sha256:resolved",
			tag: "1.24.4",
		});
	});

	test("nothing newer means nothing to notify", async () => {
		const { row, svc } = fakeService();
		registryTags = [{ digest: "sha256:old", name: "1.24.3" }];
		expect((await ImageVersionService.check(svc))?.available).toBeNull();
		expect(notifications).toEqual([]);
		expect(row.updateCheck).toMatchObject({ available: null, error: null });
	});

	test("a floating tag updates when the registry's digest moved past the running one", async () => {
		const { svc } = fakeService({ tag: "latest" });
		remoteDigests.set("latest", "sha256:new");
		deployments = [
			{ imageDigest: "sha256:old", imageId: "i", status: "running" },
		];
		const state = await ImageVersionService.check(svc);
		expect(state?.available).toMatchObject({
			digest: "sha256:new",
			tag: "latest",
		});
		expect(notifications[0].message).toBe(
			'"Gitea" can update to a newer latest image.',
		);
	});

	test("a floating tag on the same digest, or pinned locally, has no update", async () => {
		const same = fakeService({ tag: "latest" });
		remoteDigests.set("latest", "sha256:same");
		deployments = [
			{ imageDigest: "sha256:same", imageId: "i", status: "running" },
		];
		expect((await ImageVersionService.check(same.svc))?.available).toBeNull();
		resolveCalls.length = 0;
		const local = fakeService({ pinnedLocally: true, tag: "nightly-1" });
		expect((await ImageVersionService.check(local.svc))?.available).toBeNull();
		expect(resolveCalls).toEqual([]);
	});

	test("a registry failure is recorded, keeping the update already seen", async () => {
		const previous = {
			available: { digest: "sha256:n", foundAt: "t1", tag: "1.24.4" },
			checkedAt: "t0",
			error: null,
			notifiedKey: "1.24.4@sha256:n",
			trial: { at: "t2", message: "ok", status: "passed", tag: "1.24.4" },
		};
		const { row, svc } = fakeService({ updateCheck: previous });
		registryError = new Error("registry down");
		const state = await ImageVersionService.check(svc);
		expect(state).toMatchObject({
			available: previous.available,
			error: "registry down",
			notifiedKey: "1.24.4@sha256:n",
			trial: previous.trial,
		});
		expect(row.updateCheck).toMatchObject({ error: "registry down" });
		expect(warnings).toEqual([
			"Update check failed: service=s1 : registry down",
		]);
		expect(notifications).toEqual([]);
	});

	test("a check already in flight isn't started twice", async () => {
		const { svc } = fakeService({ tag: "latest" });
		const gate = deferred();
		stub(ApiService, "resolveDigest", async () => {
			resolveCalls.push("latest");
			await gate.promise;
			return null;
		});
		const running = ImageVersionService.check(svc);
		expect(await ImageVersionService.check(svc)).toBeNull();
		gate.release();
		await running;
		expect(resolveCalls).toEqual(["latest"]);
		await ImageVersionService.check(svc);
		expect(resolveCalls).toEqual(["latest", "latest"]);
	});
});

describe("ImageVersionService update trials", () => {
	test("runs the update off every network and volume and passes once healthy", async () => {
		const { svc, updates } = fakeService({ updateTrialEnabled: true });
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		inspects = [
			{ Health: { Status: "starting" }, Running: true },
			{ Health: { Status: "healthy" }, Running: true },
		];
		const state = await ImageVersionService.check(svc);
		expect(state?.trial).toMatchObject({
			message: "Reported healthy.",
			status: "passed",
			tag: "1.24.4",
		});
		expect(pulls).toEqual([
			{ auth: AUTH, image: "gitea/gitea", tag: "1.24.4@sha256:new" },
		]);
		expect(containerCreate()).toEqual({
			body: {
				Cmd: ["serve"],
				Entrypoint: undefined,
				Env: ["A=1"],
				HostConfig: { NetworkMode: "bridge", RestartPolicy: { Name: "no" } },
				Healthcheck: listeningHealthcheck(3000, NO_TIMING),
				Image: "gitea/gitea@sha256:new",
				Labels: { "homerun.update-trial": "s1" },
			},
			name: "homerun-trial-gitea",
		});
		const deletes = workerCalls.filter((call) => call[0] === "delete");
		expect(deletes).toEqual([
			["delete", "v1/containers/homerun-trial-gitea", { force: "1" }],
			["delete", "v1/containers/trial-1", { force: "1" }],
		]);
		expect(
			updates.map(
				(patch) =>
					(patch.updateCheck as { trial: { status: string } | null }).trial
						?.status ?? null,
			),
		).toEqual([null, "running", "passed", "passed"]);
		expect(notifications[0].message).toBe(
			'"Gitea" can update to 1.24.4. Its trial run started cleanly.',
		);
	});

	test("a failed healthcheck fails the trial with the container's last log lines", async () => {
		const { svc } = fakeService({
			healthcheckCommand: "curl -f localhost",
			updateTrialEnabled: true,
		});
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		inspects = [{ Health: { Status: "unhealthy" }, Running: true }];
		logOutput = "\u001b[31mpanic: no database\u001b[0m\n";
		const state = await ImageVersionService.check(svc);
		const message =
			"The new version failed its healthcheck.\n\npanic: no database";
		expect(state?.trial).toMatchObject({ message, status: "failed" });
		expect(containerCreate()?.body.Healthcheck).toEqual(
			dockerHealthcheck("curl -f localhost", NO_TIMING),
		);
		expect(notifications[0]).toMatchObject({
			detail: message,
			message: '"Gitea" can update to 1.24.4. Its trial run failed.',
		});
		expect(workerCalls.at(-1)).toEqual([
			"delete",
			"v1/containers/trial-1",
			{ force: "1" },
		]);
	});

	test("a container that exits fails the trial, and so does a failed pull", async () => {
		const exited = fakeService({ updateTrialEnabled: true });
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		inspects = [{ ExitCode: 3, Running: false }];
		expect((await ImageVersionService.check(exited.svc))?.trial).toMatchObject({
			message: "The new version exited with code 3.",
			status: "failed",
		});
		inspects = [null];
		const vanished = fakeService({ updateTrialEnabled: true });
		expect(
			(await ImageVersionService.check(vanished.svc))?.trial?.message,
		).toBe("The new version exited with code unknown.");
		pullError = new Error("manifest unknown");
		const unpulled = fakeService({ updateTrialEnabled: true });
		expect(
			(await ImageVersionService.check(unpulled.svc))?.trial,
		).toMatchObject({
			message: "manifest unknown",
			status: "failed",
		});
	});

	test("without healthchecks it passes once still running after the settle time", async () => {
		const { svc } = fakeService({
			healthcheckDisabled: true,
			updateTrialEnabled: true,
		});
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		inspects = [{ Running: true }];
		const started = now;
		const state = await ImageVersionService.check(svc);
		expect(state?.trial).toMatchObject({
			message: "Still running after 20s.",
			status: "passed",
		});
		expect(now - started).toBe(20_000);
		expect(containerCreate()?.body.Healthcheck).toBeUndefined();
	});

	test("gives up on a version that never reports healthy, pulling it by tag without a digest", async () => {
		const { svc } = fakeService({ updateTrialEnabled: true });
		registryTags = [{ digest: null, name: "1.24.4" }];
		inspects = [{ Health: { Status: "starting" }, Running: true }];
		const state = await ImageVersionService.check(svc);
		expect(state?.trial).toMatchObject({
			message: "The new version never reported healthy.",
			status: "failed",
		});
		expect(pulls).toEqual([
			{ auth: AUTH, image: "gitea/gitea", tag: "1.24.4" },
		]);
		expect(containerCreate()?.body.Image).toBe("gitea/gitea:1.24.4");
	});

	test("an update already tried isn't tried again, one left running is", async () => {
		const available = { digest: "sha256:new", foundAt: "t1", tag: "1.24.4" };
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		const tried = fakeService({
			updateCheck: {
				available,
				checkedAt: "t0",
				error: null,
				notifiedKey: "1.24.4@sha256:new",
				trial: { at: "t2", message: "ok", status: "passed", tag: "1.24.4" },
			},
			updateTrialEnabled: true,
		});
		const kept = await ImageVersionService.check(tried.svc);
		expect(kept?.trial?.at).toBe("t2");
		expect(pulls).toEqual([]);
		expect(notifications).toEqual([]);
		const interrupted = fakeService({
			updateCheck: {
				available,
				checkedAt: "t0",
				error: null,
				notifiedKey: null,
				trial: { at: "t2", message: null, status: "running", tag: "1.24.4" },
			},
			updateTrialEnabled: true,
		});
		const redone = await ImageVersionService.check(interrupted.svc);
		expect(redone?.trial?.status).toBe("passed");
		expect(pulls).toHaveLength(1);
	});

	test("a background check answers before the trial and the notification", async () => {
		const { svc } = fakeService({ updateTrialEnabled: true });
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		const gate = deferred();
		pullGate = gate.promise;
		const state = await ImageVersionService.check(svc, { background: true });
		expect(state?.available?.tag).toBe("1.24.4");
		expect(notifications).toEqual([]);
		gate.release();
		await settle(() => notifications.length > 0);
		expect(notifications).toHaveLength(1);
	});

	test("a background trial that can't be recorded is logged", async () => {
		const { svc } = fakeService({ updateTrialEnabled: true });
		registryTags = [{ digest: "sha256:new", name: "1.24.4" }];
		const record = svc.update.bind(svc);
		let saves = 0;
		stub(svc, "update", async (patch: Record<string, unknown>) => {
			saves += 1;
			if (saves > 1) {
				throw new Error("db down");
			}
			await record(patch);
		});
		await ImageVersionService.check(svc, { background: true });
		await settle(() => warnings.length > 0);
		expect(warnings).toEqual(["Update trial failed: service=s1"]);
	});
});

describe("ImageVersionService.applyUpdate", () => {
	test("refuses when there's nothing to apply", async () => {
		await expect(
			ImageVersionService.applyUpdate(fakeService().svc, "u1"),
		).rejects.toThrow("There's no update to apply.");
		expect(deploys).toEqual([]);
	});

	test("moves onto the new tag, back to pulling after a local pin, and deploys", async () => {
		const { svc, updates } = fakeService({
			pinnedLocally: true,
			tag: "1.24.3-dev",
			updateCheck: {
				available: { digest: "sha256:n", foundAt: "t", tag: "1.24.4" },
			},
		});
		await ImageVersionService.applyUpdate(svc, "u1");
		expect(updates).toEqual([
			{
				pinnedLocally: false,
				pullPolicy: "always",
				tag: "1.24.4",
				updateCheck: null,
			},
		]);
		expect(deploys).toEqual([
			{ note: "Updating to gitea/gitea:1.24.4", svc, userId: "u1" },
		]);
	});
});
