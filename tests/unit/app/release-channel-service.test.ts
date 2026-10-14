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
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { CapacityService } = await import(
	"../../../src/lib/services/capacity.service"
);
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { ServiceLifecycleService } = await import(
	"../../../src/lib/services/service-lifecycle.service"
);
const { ReleaseChannelError, ReleaseChannelService } = await import(
	"../../../src/lib/services/release-channel.service"
);

type Svc = Parameters<typeof ReleaseChannelService.status>[0];

function fakeService(overrides: Record<string, unknown> = {}) {
	const updates: Record<string, unknown>[] = [];
	const svc = {
		authAllowedEmails: [],
		authAllowedGroups: [],
		authAllowedUserIds: [],
		authProviders: [],
		buildSource: "git",
		channelBranch: null,
		channelCanaryDomain: null,
		channelTagPattern: "v*",
		channelsEnabled: false,
		currentStatus: "running",
		defaultDomainEnabled: true,
		dnsResolvable: true,
		domains: [],
		envVars: {},
		gitRef: "main",
		id: "parent",
		image: "img",
		name: "Web",
		previewParentId: null,
		primaryDomain: null,
		slug: "web",
		stackId: null,
		tag: "latest",
		toJSON() {
			return this;
		},
		async update(patch: Record<string, unknown>) {
			updates.push(patch);
			Object.assign(svc, patch);
		},
		userId: "u1",
		...overrides,
	};
	return { svc: svc as unknown as Svc, updates };
}

let canary: Svc | null = null;
let canaryUpdates: Record<string, unknown>[] = [];
let created: Record<string, unknown>[] = [];
let enqueued: { svc: { id: string }; trigger: string }[] = [];
let deleted: string[] = [];
let slugTaken = false;
let owners: DomainOwners;
let refusal: string | null = null;
const originalBaseDomain = config.baseDomain;

let environments: Svc[] = [];

beforeEach(async () => {
	owners = await stubDomainOwners();
	canary = null;
	canaryUpdates = [];
	created = [];
	enqueued = [];
	deleted = [];
	slugTaken = false;
	refusal = null;
	config.baseDomain = "example.com";
	stub(Logger.prototype, "info", () => undefined);
	stub(ServiceGitDTO, "getCanary", async () => canary);
	environments = [];
	stub(ServiceGitDTO, "listEnvironments", async () => environments);
	stub(ServiceDTO, "slugTaken", async () => slugTaken);
	stub(CapacityService, "refusal", async () => refusal);
	stub(StackDTO, "get", async (id: string) => ({ id, slug: "stk" }));
	stub(ServiceDTO, "create", async (input: Record<string, unknown>) => {
		created.push(input);
		const made = fakeService({ ...input, id: "canary" });
		canaryUpdates = made.updates;
		return made.svc;
	});
	stub(
		DeploymentService,
		"enqueueDeploy",
		async (input: { svc: { id: string }; trigger: string }) => {
			enqueued.push(input);
			return { deploymentId: "d1", jobId: "j1" };
		},
	);
	stub(ServiceLifecycleService, "deleteService", async (svc: Svc) => {
		deleted.push(svc.id);
	});
});

afterEach(() => {
	config.baseDomain = originalBaseDomain;
	restoreStubs();
});

describe("ReleaseChannelService.configure", () => {
	test("refuses to turn on while a canary environment holds the name", async () => {
		environments = [
			fakeService({ environmentName: "canary", id: "env-canary" }).svc,
		];
		const { svc } = fakeService();
		await expect(
			ReleaseChannelService.configure(svc, { enabled: true }, "u1"),
		).rejects.toThrow("canary environment");
	});

	test("refuses a service that doesn't build from git", async () => {
		const { svc } = fakeService({ buildSource: "image" });
		await expect(
			ReleaseChannelService.configure(svc, { enabled: true }, "u1"),
		).rejects.toBeInstanceOf(ReleaseChannelError);
	});

	test("refuses a blank tag pattern and an invalid or taken canary domain", async () => {
		const { svc } = fakeService();
		await expect(
			ReleaseChannelService.configure(
				svc,
				{ enabled: true, tagPattern: "v *" },
				"u1",
			),
		).rejects.toThrow("spaces");
		await expect(
			ReleaseChannelService.configure(
				svc,
				{ canaryDomain: "not a domain", enabled: true },
				"u1",
			),
		).rejects.toThrow("isn't a valid domain");
		owners.services.push({ domains: ["canary.example.org"], id: "other" });
		await expect(
			ReleaseChannelService.configure(
				svc,
				{ canaryDomain: "canary.example.org", enabled: true },
				"u1",
			),
		).rejects.toThrow('already routed to the service "other"');
		owners.services = [];
		owners.redirects.push("canary.example.org/old");
		await expect(
			ReleaseChannelService.configure(
				svc,
				{ canaryDomain: "canary.example.org", enabled: true },
				"u1",
			),
		).rejects.toThrow("already routed to the redirect");
		owners.redirects = [];
		await expect(
			ReleaseChannelService.configure(
				svc,
				{ canaryDomain: "web.example.com", enabled: true },
				"u1",
			),
		).rejects.toThrow("where this service itself answers");
	});

	test("turning channels on creates the canary on the branch and deploys it", async () => {
		const { svc, updates } = fakeService();
		await ReleaseChannelService.configure(
			svc,
			{
				canaryDomain: "canary.example.org",
				enabled: true,
				tagPattern: "rel-*",
			},
			"u1",
		);
		expect(updates[0]).toEqual({
			channelBranch: "main",
			channelCanaryDomain: "canary.example.org",
			channelTagPattern: "rel-*",
			channelsEnabled: true,
		});
		expect(created[0]).toMatchObject({
			channelCanary: true,
			domains: ["canary.example.org"],
			gitRef: "main",
			previewParentId: "parent",
			slug: "web-canary",
		});
		expect(created[0]).not.toHaveProperty("uptimeEnabled");
		expect(canaryUpdates[0]).toMatchObject({
			defaultDomainEnabled: false,
			primaryDomain: "canary.example.org",
		});
		expect(enqueued.map((e) => e.svc.id)).toEqual(["canary"]);
	});

	test("turning channels off deletes the canary", async () => {
		canary = fakeService({ id: "canary" }).svc;
		const { svc } = fakeService({ channelsEnabled: true });
		await ReleaseChannelService.configure(svc, { enabled: false }, "u1");
		expect(deleted).toEqual(["canary"]);
		expect(enqueued).toHaveLength(0);
	});

	test("changing the canary domain redeploys the canary on it", async () => {
		const existing = fakeService({
			dnsResolvable: false,
			gitRef: "main",
			id: "canary",
		});
		canary = existing.svc;
		const { svc } = fakeService({
			channelBranch: "main",
			channelCanaryDomain: "old.example.org",
			channelsEnabled: true,
			dnsResolvable: false,
		});
		await ReleaseChannelService.configure(
			svc,
			{ canaryDomain: "new.example.org", enabled: true },
			"u1",
		);
		expect(existing.updates[0]).toMatchObject({
			domains: ["new.example.org"],
		});
		expect(enqueued.map((e) => e.svc.id)).toEqual(["canary"]);
	});

	test("an unchanged configuration doesn't redeploy the canary", async () => {
		canary = fakeService({ gitRef: "main", id: "canary" }).svc;
		const { svc } = fakeService({
			channelBranch: "main",
			channelsEnabled: true,
		});
		await ReleaseChannelService.configure(svc, { enabled: true }, "u1");
		expect(enqueued).toHaveLength(0);
	});
});

describe("ReleaseChannelService deploys", () => {
	test("a canary deploy needs channels on", async () => {
		const { svc } = fakeService();
		await expect(
			ReleaseChannelService.deployCanary(svc, {
				trigger: "push",
				userId: "u1",
			}),
		).rejects.toThrow("Release channels are off");
	});

	test("refreshes an existing canary and records the pushed commit", async () => {
		const existing = fakeService({ dnsResolvable: false, id: "canary" });
		canary = existing.svc;
		const { svc } = fakeService({
			channelBranch: "develop",
			channelsEnabled: true,
		});
		const result = await ReleaseChannelService.deployCanary(svc, {
			commit: "abc",
			trigger: "push",
			userId: "u1",
		});
		expect(result).toEqual({
			deploymentId: "d1",
			jobId: "j1",
			serviceId: "canary",
			status: "deployed",
		});
		expect(existing.updates[0]).toMatchObject({ gitRef: "develop" });
		expect(existing.updates[1]).toEqual({ gitLastSeenCommit: "abc" });
	});

	test("won't create a canary over a taken slug or past capacity", async () => {
		const { svc } = fakeService({ channelsEnabled: true });
		slugTaken = true;
		await expect(
			ReleaseChannelService.deployCanary(svc, {
				trigger: "push",
				userId: "u1",
			}),
		).rejects.toThrow("already taken");
		slugTaken = false;
		refusal = "At capacity.";
		await expect(
			ReleaseChannelService.deployCanary(svc, {
				trigger: "push",
				userId: "u1",
			}),
		).rejects.toThrow("At capacity.");
	});

	test("a pushed tag becomes the stable service's ref before it deploys", async () => {
		const { svc, updates } = fakeService({ channelsEnabled: true });
		await ReleaseChannelService.deployStable(svc, {
			tag: "v1.2.0",
			trigger: "push",
			userId: "u1",
		});
		expect(updates[0]).toEqual({ gitRef: "v1.2.0" });
		expect(enqueued.map((e) => e.svc.id)).toEqual(["parent"]);
	});
});

describe("ReleaseChannelService.status", () => {
	test("reports the settings and the canary with its hostname", async () => {
		canary = fakeService({
			gitRef: "main",
			id: "canary",
			name: "Web (canary)",
			slug: "web-canary",
		}).svc;
		const { svc } = fakeService({
			channelBranch: "main",
			channelsEnabled: true,
			stackId: "s1",
		});
		expect(await ReleaseChannelService.status(svc)).toEqual({
			branch: "main",
			canary: {
				gitRef: "main",
				hostname: "stk-web-canary.example.com",
				id: "canary",
				name: "Web (canary)",
				slug: "web-canary",
				status: "running",
			},
			canaryDomain: null,
			enabled: true,
			stableRef: "main",
			tagPattern: "v*",
		});
	});
});
