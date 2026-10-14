import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type DomainOwners, stubDomainOwners } from "../support/domain-owners";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { ServiceGitDTO } = await import("../../../src/lib/dto/service-git-dto");
const { CapacityService } = await import(
	"../../../src/lib/services/capacity.service"
);
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { ServiceLifecycleService } = await import(
	"../../../src/lib/services/service-lifecycle.service"
);
const { deployEnvironment, ENVIRONMENT_PRESETS, newEnvironmentProblem } =
	await import("../../../src/lib/release-channels");
const { EnvironmentError, EnvironmentService, environmentSlug } = await import(
	"../../../src/lib/services/environment.service"
);

type Svc = Parameters<typeof EnvironmentService.list>[0];

function fakeService(fields: Record<string, unknown>) {
	const state: Record<string, unknown> = {
		autoDeployOnPush: true,
		buildSource: "git",
		channelCanary: false,
		channelsEnabled: false,
		defaultDomainEnabled: true,
		dnsResolvable: false,
		domains: [],
		environmentName: null,
		envVars: {},
		gitIgnorePaths: [],
		gitRef: "main",
		gitWatchPaths: [],
		image: "app",
		name: "App",
		portProtocol: "tcp",
		previewParentId: null,
		previewPrNumber: null,
		primaryDomain: null,
		pullPolicy: "always",
		restartPolicy: "unless-stopped",
		slug: "app",
		stackId: null,
		tag: "latest",
		userId: "owner",
		...fields,
	};
	const updates: Record<string, unknown>[] = [];
	const svc = {
		...state,
		get envVars() {
			return state.envVars;
		},
		get gitRef() {
			return state.gitRef;
		},
		get tag() {
			return state.tag;
		},
		toJSON: () => state,
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
			Object.assign(state, patch);
		},
	};
	return { state, svc: svc as unknown as Svc, updates };
}

const originalBaseDomain = config.baseDomain;
let environments: Svc[] = [];
let created: Record<string, unknown>[] = [];
let enqueued: unknown[] = [];
let deleted: unknown[] = [];
let slugTaken = false;
let owners: DomainOwners;
let full: string | null = null;

beforeEach(async () => {
	owners = await stubDomainOwners();
	config.baseDomain = "example.com";
	environments = [];
	created = [];
	enqueued = [];
	deleted = [];
	slugTaken = false;
	full = null;
	stub(Logger.prototype, "info", () => undefined);
	stub(Logger.prototype, "warn", () => undefined);
	stub(ServiceGitDTO, "listEnvironments", async () => environments);
	stub(ServiceDTO, "slugTaken", async () => slugTaken);
	stub(CapacityService, "refusal", async () => full);
	stub(ServiceDTO, "create", async (input: Record<string, unknown>) => {
		created.push(input);
		return fakeService({ ...input, id: "env1" }).svc;
	});
	stub(DeploymentService, "enqueueDeploy", async (input: unknown) => {
		enqueued.push(input);
		return { deploymentId: "d", jobId: "j" };
	});
	stub(ServiceLifecycleService, "deleteService", async (svc: unknown) => {
		deleted.push(svc);
	});
});

afterEach(() => {
	config.baseDomain = originalBaseDomain;
	restoreStubs();
});

describe("environment names", () => {
	test("presets are the six common environments", () => {
		expect([...ENVIRONMENT_PRESETS]).toEqual([
			"prod",
			"staging",
			"canary",
			"test",
			"dev",
			"demo",
		]);
	});

	test("refuses a taken, reserved or malformed name", () => {
		const service = {
			channelsEnabled: false,
			taken: ["production", "staging"],
		};
		expect(newEnvironmentProblem("staging", service)).toContain("already");
		expect(newEnvironmentProblem("preview", service)).toContain("reserved");
		expect(newEnvironmentProblem("pr-12", service)).toContain("reserved");
		expect(newEnvironmentProblem("Bad Name", service)).toContain("lowercase");
		expect(newEnvironmentProblem("", service)).toContain("name");
		expect(newEnvironmentProblem("demo", service)).toBeNull();
	});

	test("canary is free unless release channels own it", () => {
		expect(
			newEnvironmentProblem("canary", { channelsEnabled: false, taken: [] }),
		).toBeNull();
		expect(
			newEnvironmentProblem("canary", { channelsEnabled: true, taken: [] }),
		).toContain("release channel");
	});

	test("an environment deploys under its own name, a preview as preview", () => {
		const base = { channelCanary: false, previewParentId: "p" };
		expect(deployEnvironment({ ...base, environmentName: "staging" })).toBe(
			"staging",
		);
		expect(deployEnvironment({ ...base, environmentName: null })).toBe(
			"preview",
		);
	});

	test("the slug stays a DNS label", () => {
		expect(environmentSlug("app", "staging")).toBe("app-staging");
		expect(environmentSlug("x".repeat(70), "demo")).toHaveLength(63);
	});
});

describe("EnvironmentService.create", () => {
	test("creates a child following the parent and queues its deploy", async () => {
		const parent = fakeService({
			envVars: { ORIGIN: "https://app.example.com" },
			id: "parent",
		});
		const environment = await EnvironmentService.create(
			parent.svc,
			"staging",
			{ domain: null, envOverrides: { MODE: "staging" }, ref: "develop" },
			{ userId: "user1" },
		);
		expect(created[0]).toMatchObject({
			gitRef: "develop",
			name: "App (staging)",
			previewParentId: "parent",
			slug: "app-staging",
		});
		expect(created[0]).not.toHaveProperty("uptimeEnabled");
		expect(environment.toJSON()).toMatchObject({
			environmentName: "staging",
			envVars: {
				MODE: "staging",
				ORIGIN: "https://app-staging.example.com",
			},
		});
		expect(enqueued).toHaveLength(1);
	});

	test("created without its first deploy when asked", async () => {
		const parent = fakeService({ id: "parent" });
		await EnvironmentService.create(
			parent.svc,
			"demo",
			{ domain: null, envOverrides: {}, ref: "main" },
			{ deploy: false, userId: "user1" },
		);
		expect(created).toHaveLength(1);
		expect(enqueued).toHaveLength(0);
	});

	test("a half-created environment is removed when its second write fails", async () => {
		stub(ServiceDTO, "create", async (input: Record<string, unknown>) => {
			created.push(input);
			const made = fakeService({ ...input, id: "env1" });
			(made.svc as unknown as { update: () => Promise<void> }).update =
				async () => {
					throw new Error("db down");
				};
			return made.svc;
		});
		const parent = fakeService({ id: "parent" });
		await expect(
			EnvironmentService.create(
				parent.svc,
				"demo",
				{ domain: null, envOverrides: {}, ref: "main" },
				{ userId: "u" },
			),
		).rejects.toThrow("db down");
		expect(deleted).toHaveLength(1);
		expect(enqueued).toHaveLength(0);
	});

	test("an image service's environment runs another tag", async () => {
		const parent = fakeService({ buildSource: "image", id: "parent" });
		await EnvironmentService.create(
			parent.svc,
			"demo",
			{ domain: null, envOverrides: {}, ref: "1.2.3" },
			{ userId: "user1" },
		);
		expect(created[0]).toMatchObject({ gitRef: "main", tag: "1.2.3" });
	});

	test("refuses a taken name, slug or domain, a full instance, and an environment's environment", async () => {
		const parent = fakeService({ id: "parent" });
		const input = { domain: "staging.example.com", envOverrides: {}, ref: "x" };
		await expect(
			EnvironmentService.create(parent.svc, "production", input, {
				userId: "u",
			}),
		).rejects.toBeInstanceOf(EnvironmentError);
		slugTaken = true;
		await expect(
			EnvironmentService.create(parent.svc, "staging", input, { userId: "u" }),
		).rejects.toThrow("slug");
		slugTaken = false;
		owners.services.push({ domains: ["staging.example.com"], id: "other" });
		await expect(
			EnvironmentService.create(parent.svc, "staging", input, { userId: "u" }),
		).rejects.toThrow('already routed to the service "other"');
		owners.services = [];
		owners.workstations.push("staging.example.com");
		await expect(
			EnvironmentService.create(parent.svc, "staging", input, { userId: "u" }),
		).rejects.toThrow("already routed to a workstation");
		owners.workstations = [];
		full = "This instance is full.";
		await expect(
			EnvironmentService.create(parent.svc, "staging", input, { userId: "u" }),
		).rejects.toThrow("full");
		const child = fakeService({ id: "c", previewParentId: "parent" });
		await expect(
			EnvironmentService.create(child.svc, "demo", input, { userId: "u" }),
		).rejects.toThrow("service itself");
		expect(created).toHaveLength(0);
	});
});

describe("EnvironmentService.update and delete", () => {
	test("repoints the source and domain, keeping its own env vars", async () => {
		const parent = fakeService({ id: "parent" });
		const environment = fakeService({
			envVars: { DATABASE_URL: "staging-db" },
			environmentName: "staging",
			id: "env1",
			previewParentId: "parent",
		});
		environments = [environment.svc];
		await EnvironmentService.update(parent.svc, "env1", {
			domain: "staging.example.com",
			envOverrides: { MODE: "staging" },
			ref: "release",
		});
		expect(environment.state).toMatchObject({
			domains: ["staging.example.com"],
			envVars: { DATABASE_URL: "staging-db", MODE: "staging" },
			gitRef: "release",
			primaryDomain: "staging.example.com",
		});
	});

	test("keeps the domains it got elsewhere when its main one changes", async () => {
		const parent = fakeService({ id: "parent" });
		const environment = fakeService({
			domains: ["a.example.com", "b.example.com"],
			id: "env1",
			previewParentId: "parent",
			primaryDomain: "a.example.com",
		});
		environments = [environment.svc];
		await EnvironmentService.update(parent.svc, "env1", {
			domain: "c.example.com",
			envOverrides: {},
			ref: "main",
		});
		expect(environment.state.domains).toEqual([
			"c.example.com",
			"b.example.com",
		]);
		await EnvironmentService.update(parent.svc, "env1", {
			domain: null,
			envOverrides: {},
			ref: "main",
		});
		expect(environment.state).toMatchObject({
			domains: ["b.example.com"],
			primaryDomain: "b.example.com",
		});
	});

	test("deletes only its own environments", async () => {
		const parent = fakeService({ id: "parent" });
		const environment = fakeService({ id: "env1", previewParentId: "parent" });
		environments = [environment.svc];
		await EnvironmentService.delete(parent.svc, "env1");
		expect(deleted).toEqual([environment.svc]);
		await expect(
			EnvironmentService.delete(parent.svc, "other"),
		).rejects.toBeInstanceOf(EnvironmentError);
	});
});

describe("EnvironmentService.deployPushes", () => {
	test("deploys the environments building a pushed branch", async () => {
		const parent = fakeService({ id: "parent" });
		const staging = fakeService({ gitRef: "develop", id: "s" });
		const demo = fakeService({ gitRef: "demo", id: "d" });
		const manual = fakeService({
			autoDeployOnPush: false,
			gitRef: "develop",
			id: "m",
		});
		environments = [staging.svc, demo.svc, manual.svc];
		expect(
			await EnvironmentService.deployPushes(parent.svc, [
				{ branch: "develop", commit: "abc", files: null },
			]),
		).toBe(1);
		expect(staging.state.gitLastSeenCommit).toBe("abc");
		expect(enqueued).toHaveLength(1);
	});

	test("skips an environment whose watch paths the push misses", async () => {
		const parent = fakeService({ id: "parent" });
		const api = fakeService({
			gitRef: "develop",
			gitWatchPaths: ["apps/api/**"],
			id: "a",
		});
		const web = fakeService({
			gitIgnorePaths: ["docs/**"],
			gitRef: "develop",
			id: "w",
		});
		environments = [api.svc, web.svc];
		expect(
			await EnvironmentService.deployPushes(parent.svc, [
				{ branch: "develop", commit: "abc", files: ["apps/web/page.ts"] },
			]),
		).toBe(1);
		expect(api.state.gitLastSeenCommit).toBe("abc");
		expect(enqueued).toHaveLength(1);
	});

	test("skips a commit it already deployed", async () => {
		const parent = fakeService({ id: "parent" });
		environments = [
			fakeService({ gitLastSeenCommit: "abc", gitRef: "develop", id: "s" }).svc,
		];
		expect(
			await EnvironmentService.deployPushes(parent.svc, [
				{ branch: "develop", commit: "abc", files: null },
			]),
		).toBe(0);
		expect(enqueued).toHaveLength(0);
	});

	test("an image service or no push deploys nothing", async () => {
		const image = fakeService({ buildSource: "image", id: "i" });
		expect(
			await EnvironmentService.deployPushes(image.svc, [
				{ branch: "main", commit: null, files: null },
			]),
		).toBe(0);
		const parent = fakeService({ id: "p" });
		expect(await EnvironmentService.deployPushes(parent.svc, [])).toBe(0);
	});

	test("a failed enqueue is logged, not thrown", async () => {
		stub(DeploymentService, "enqueueDeploy", async () => {
			throw new Error("queue down");
		});
		const parent = fakeService({ id: "parent" });
		environments = [fakeService({ gitRef: "develop", id: "s" }).svc];
		expect(
			await EnvironmentService.deployPushes(parent.svc, [
				{ branch: "develop", commit: null, files: null },
			]),
		).toBe(0);
	});
});
