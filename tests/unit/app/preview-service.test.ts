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
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { ServiceLifecycleService } = await import(
	"../../../src/lib/services/service-lifecycle.service"
);
const { PreviewService, previewVolumeSource, renderEnvOverride } = await import(
	"../../../src/lib/services/preview.service"
);
const { ServiceVolumeDTO } = await import(
	"../../../src/lib/dto/service-volume-dto"
);
const { StorageVolumeDTO } = await import(
	"../../../src/lib/dto/storage-volume-dto"
);

type Svc = Parameters<typeof PreviewService.handle>[0];
type Event = Parameters<typeof PreviewService.handle>[1];

const SHA = "a".repeat(40);

function fakeService(overrides: Record<string, unknown> = {}) {
	const updates: Record<string, unknown>[] = [];
	const svc = {
		authAllowedEmails: ["a@b.c"],
		authAllowedGroups: [],
		authAllowedUserIds: [],
		authProviders: [],
		currentStatus: "running",
		defaultDomainEnabled: true,
		dnsResolvable: true,
		domains: [],
		gitRef: "main",
		id: "parent",
		image: "img",
		name: "Web",
		previewAccessPolicy: {
			authAllowedEmails: [],
			authAllowedGroups: [],
			authAllowedUserIds: [],
			authProviders: [],
			authRequired: false,
		},
		previewBranchExclude: [],
		previewBranchInclude: [],
		previewCopyVolumes: false,
		previewEnvOverrides: {},
		previewInheritEnv: true,
		previewDefaultDomain: true,
		previewDomainTemplate: null,
		primaryDomain: null,
		slug: "web",
		stackId: null,
		tag: "latest",
		toJSON() {
			return this;
		},
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
		},
		userId: "u1",
		...overrides,
	};
	return { svc: svc as unknown as Svc, updates };
}

function event(overrides: Partial<Event> = {}): Event {
	return {
		action: "open",
		branch: "feature",
		commit: SHA,
		fromFork: false,
		number: 7,
		title: "Add thing",
		...overrides,
	};
}

let enqueued: unknown[] = [];
let deleted: string[] = [];
let deleteError: unknown = null;
let existing: Svc | null = null;
let slugTaken = false;
let created: Record<string, unknown>[] = [];
let createdUpdates: Record<string, unknown>[] = [];
let owners: DomainOwners;
let previews: Svc[] = [];
const originalBaseDomain = config.baseDomain;

beforeEach(async () => {
	owners = await stubDomainOwners();
	enqueued = [];
	deleted = [];
	deleteError = null;
	existing = null;
	slugTaken = false;
	created = [];
	createdUpdates = [];
	previews = [];
	config.baseDomain = "example.com";
	stub(Logger.prototype, "info", () => undefined);
	stub(Logger.prototype, "warn", () => undefined);
	stub(DeploymentService, "enqueueDeploy", async (input: unknown) => {
		enqueued.push(input);
		return { deploymentId: "d1", jobId: "j1" };
	});
	stub(ServiceLifecycleService, "deleteService", async (svc: Svc) => {
		if (deleteError) {
			throw deleteError;
		}
		deleted.push(svc.id);
	});
	stub(ServiceGitDTO, "getPreview", async () => existing);
	stub(ServiceGitDTO, "listPreviews", async () => previews);
	stub(ServiceDTO, "slugTaken", async () => slugTaken);
	stub(ServiceDTO, "create", async (input: Record<string, unknown>) => {
		created.push(input);
		const made = fakeService({ ...input, id: "preview" });
		createdUpdates = made.updates;
		return made.svc;
	});
	stub(StackDTO, "get", async (id: string) => ({ id, slug: "stk" }));
});

afterEach(() => {
	config.baseDomain = originalBaseDomain;
	restoreStubs();
});

describe("PreviewService.handle", () => {
	test("ignores a pull request from a fork", async () => {
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event({ fromFork: true }));
		expect(result.status).toBe("ignored");
		expect(enqueued).toHaveLength(0);
	});

	test("ignores an event with no head branch or commit", async () => {
		const { svc } = fakeService();
		const result = await PreviewService.handle(
			svc,
			event({ branch: null, commit: null }),
		);
		expect(result).toEqual({
			reason: "The pull request event carried no head branch or commit.",
			status: "ignored",
		});
	});

	test("creates and deploys a preview for a new pull request", async () => {
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event());
		expect(result).toEqual({
			deploymentId: "d1",
			jobId: "j1",
			status: "deployed",
		});
		expect(created[0]).toMatchObject({
			buildSource: "git",
			gitRef: SHA,
			name: "Web PR #7",
			previewBranch: "feature",
			previewParentId: "parent",
			previewPrNumber: 7,
			slug: "web-pr-7",
			userId: "u1",
		});
		expect(enqueued).toEqual([
			expect.objectContaining({ trigger: "push", userId: "u1" }),
		]);
	});

	test("a preview of a parent with preview uptime off gets no probes, and the parent keeps its own", async () => {
		const { svc, updates } = fakeService({
			previewUptimeEnabled: false,
			uptimeEnabled: true,
		});
		await PreviewService.handle(svc, event());
		expect(created[0].uptimeEnabled).toBe(false);
		expect(svc.uptimeEnabled).toBe(true);
		expect(updates.some((patch) => "uptimeEnabled" in patch)).toBe(false);
	});

	test("a preview of a parent with preview uptime on is probed", async () => {
		const { svc } = fakeService({ previewUptimeEnabled: true });
		await PreviewService.handle(svc, event());
		expect(created[0].uptimeEnabled).toBe(true);
	});

	test("an existing preview takes the parent's preview uptime setting on redeploy", async () => {
		const preview = fakeService({ id: "preview", uptimeEnabled: true });
		existing = preview.svc;
		const { svc } = fakeService({ previewUptimeEnabled: false });
		await PreviewService.handle(
			svc,
			event({ action: "update", commit: "b".repeat(40) }),
		);
		expect(preview.updates[0]).toMatchObject({ uptimeEnabled: false });
	});

	test("gives a new preview its templated domain", async () => {
		const { svc } = fakeService({
			previewDefaultDomain: false,
			previewDomainTemplate: "{branch}-{pr}.preview.io",
		});
		await PreviewService.handle(svc, event({ branch: "feat/Login" }));
		expect(created[0].domains).toEqual(["feat-login-7.preview.io"]);
		expect(createdUpdates[0]).toMatchObject({
			defaultDomainEnabled: false,
			primaryDomain: "feat-login-7.preview.io",
		});
	});

	test("points the parent's own domain in its env at the preview", async () => {
		const { svc } = fakeService({
			defaultDomainEnabled: false,
			domains: ["sergios.fr"],
			envVars: { ORIGIN: "https://sergios.fr", PORT: "3000" },
			previewDomainTemplate: "preview-{pr}.sergios.fr",
		});
		await PreviewService.handle(svc, event());
		expect(created[0].envVars).toEqual({
			ORIGIN: "https://preview-7.sergios.fr",
			PORT: "3000",
		});
	});

	test("keeps only the default hostname when the templated one is taken", async () => {
		owners.services.push({ domains: ["pr-7.preview.io"], id: "other" });
		const { svc } = fakeService({
			previewDefaultDomain: false,
			previewDomainTemplate: "pr-{pr}.preview.io",
		});
		await PreviewService.handle(svc, event());
		expect(created[0].domains).toEqual([]);
		expect(createdUpdates[0]).toMatchObject({
			defaultDomainEnabled: true,
			primaryDomain: null,
		});
	});

	test("skips a templated domain a workstation or a redirect routes", async () => {
		owners.workstations.push("pr-7.preview.io");
		owners.redirects.push("pr-8.preview.io/go");
		for (const number of [7, 8]) {
			const { svc } = fakeService({
				previewDefaultDomain: false,
				previewDomainTemplate: "pr-{pr}.preview.io",
			});
			// oxlint-disable-next-line no-await-in-loop -- one preview at a time
			await PreviewService.handle(svc, event({ number }));
		}
		expect(created.map((input) => input.domains)).toEqual([[], []]);
	});

	test("builds the branch when the commit isn't a full SHA", async () => {
		const { svc } = fakeService();
		await PreviewService.handle(svc, event({ commit: "abc123" }));
		expect(created[0].gitRef).toBe("feature");
	});

	test("ignores a new pull request whose slug is taken", async () => {
		slugTaken = true;
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event());
		expect(result.status).toBe("ignored");
		expect(created).toHaveLength(0);
	});

	test("refreshes and redeploys an existing preview on a new head", async () => {
		const preview = fakeService({ gitRef: "old", id: "preview" });
		existing = preview.svc;
		const { svc } = fakeService();
		const result = await PreviewService.handle(
			svc,
			event({ action: "update", title: "New" }),
		);
		expect(result.status).toBe("deployed");
		expect(preview.updates[0]).toMatchObject({
			gitRef: SHA,
			previewPrTitle: "New",
		});
	});

	test("skips the redeploy when an update left the head in place", async () => {
		const preview = fakeService({ gitRef: SHA, id: "preview" });
		existing = preview.svc;
		const { svc } = fakeService();
		const result = await PreviewService.handle(
			svc,
			event({ action: "update" }),
		);
		expect(result.status).toBe("ignored");
		expect(enqueued).toHaveLength(0);
		expect(preview.updates).toHaveLength(1);
	});

	test("a reopened pull request always redeploys", async () => {
		existing = fakeService({ gitRef: SHA, id: "preview" }).svc;
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event());
		expect(result.status).toBe("deployed");
	});

	test("removes the preview of a closed pull request", async () => {
		existing = fakeService({ id: "preview" }).svc;
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event({ action: "close" }));
		expect(result).toEqual({ serviceId: "preview", status: "removed" });
		expect(deleted).toEqual(["preview"]);
	});

	test("ignores closing a pull request with no preview", async () => {
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event({ action: "close" }));
		expect(result).toEqual({ reason: "No preview for #7.", status: "ignored" });
	});

	test("reports a teardown failure instead of throwing", async () => {
		existing = fakeService({ id: "preview" }).svc;
		deleteError = new Error("docker down");
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event({ action: "close" }));
		expect(result).toEqual({ reason: "docker down", status: "ignored" });
	});

	test("stringifies a non-Error teardown failure", async () => {
		existing = fakeService({ id: "preview" }).svc;
		deleteError = "boom";
		const { svc } = fakeService();
		const result = await PreviewService.handle(svc, event({ action: "close" }));
		expect(result).toEqual({ reason: "boom", status: "ignored" });
	});
});

describe("PreviewService.removeAll", () => {
	test("deletes every preview and survives one failing", async () => {
		previews = [fakeService({ id: "p1" }).svc, fakeService({ id: "p2" }).svc];
		const { svc } = fakeService();
		stub(ServiceLifecycleService, "deleteService", async (preview: Svc) => {
			if (preview.id === "p1") {
				throw new Error("stuck");
			}
			deleted.push(preview.id);
		});
		await PreviewService.removeAll(svc);
		expect(deleted).toEqual(["p2"]);
	});
});

describe("PreviewService.list", () => {
	test("summarises previews with hostnames under the parent's stack", async () => {
		previews = [
			fakeService({
				id: "p1",
				previewBranch: "feature",
				previewPrNumber: 7,
				previewPrTitle: "Add thing",
				slug: "web-pr-7",
			}).svc,
			fakeService({ dnsResolvable: false, id: "p2", slug: "web-pr-8" }).svc,
		];
		const { svc } = fakeService({ stackId: "s1" });
		const list = await PreviewService.list(svc);
		expect(list[0]).toEqual({
			branch: "feature",
			gitRef: "main",
			hostname: "stk-web-pr-7.example.com",
			hostnames: ["stk-web-pr-7.example.com"],
			id: "p1",
			name: "Web",
			prNumber: 7,
			slug: "web-pr-7",
			status: "running",
			tag: null,
			title: "Add thing",
		});
		expect(list[1]).toMatchObject({ hostname: null, prNumber: 0 });
	});

	test("uses the bare slug outside a stack", async () => {
		previews = [fakeService({ id: "p1", slug: "web-pr-7" }).svc];
		const { svc } = fakeService();
		const list = await PreviewService.list(svc);
		expect(list[0].hostname).toBe("web-pr-7.example.com");
	});
});

describe("PreviewService.applyDomains / redeploy / delete", () => {
	test("re-applies the template to open previews and redeploys deployed ones", async () => {
		const deployed = fakeService({
			containerId: "c1",
			dnsResolvable: false,
			id: "p1",
			previewBranch: "a",
			previewParentId: "parent",
			previewPrNumber: 1,
		});
		const idle = fakeService({
			dnsResolvable: false,
			id: "p2",
			previewBranch: "b",
			previewParentId: "parent",
			previewPrNumber: 2,
		});
		previews = [deployed.svc, idle.svc];
		const { svc } = fakeService({ previewDomainTemplate: "pr-{pr}.x.io" });
		await PreviewService.applyDomains(svc);
		expect(deployed.updates[0]).toEqual({
			defaultDomainEnabled: true,
			domains: ["pr-1.x.io"],
			primaryDomain: "pr-1.x.io",
		});
		expect(idle.updates[0]).toMatchObject({ domains: ["pr-2.x.io"] });
		expect(enqueued).toHaveLength(1);
	});

	test("refuses to act on a service that isn't this one's preview", async () => {
		const other = fakeService({ id: "p9", previewParentId: "someone-else" });
		stub(ServiceDTO, "get", async () => other.svc);
		const { svc } = fakeService();
		await expect(PreviewService.redeploy(svc, "p9")).rejects.toThrow(
			"doesn't belong",
		);
		await expect(PreviewService.delete(svc, "p9")).rejects.toThrow(
			"doesn't belong",
		);
		expect(enqueued).toHaveLength(0);
		expect(deleted).toHaveLength(0);
	});

	test("redeploys and deletes its own preview", async () => {
		const own = fakeService({ id: "p1", previewParentId: "parent" });
		stub(ServiceDTO, "get", async () => own.svc);
		const { svc } = fakeService();
		expect((await PreviewService.redeploy(svc, "p1")).status).toBe("deployed");
		await PreviewService.delete(svc, "p1");
		expect(deleted).toEqual(["p1"]);
	});
});

describe("PreviewService preview access policy", () => {
	const clientOnly = {
		authAllowedEmails: [],
		authAllowedGroups: [],
		authAllowedUserIds: ["client-1"],
		authProviders: ["email-otp"],
		authRequired: true,
	};

	test("a new preview gets the parent's preview policy, not its own wall", async () => {
		const { svc } = fakeService({
			authAllowedEmails: ["owner@x.io"],
			authRequired: false,
			previewAccessPolicy: clientOnly,
		});
		await PreviewService.handle(svc, event());
		expect(created[0].authRequired).toBe(true);
		expect(createdUpdates[0]).toMatchObject({
			authAllowedEmails: [],
			authAllowedUserIds: ["client-1"],
			authProviders: ["email-otp"],
		});
	});

	test("a pull request update re-applies the preview policy", async () => {
		const preview = fakeService({ gitRef: "old", id: "preview" });
		existing = preview.svc;
		const { svc } = fakeService({ previewAccessPolicy: clientOnly });
		await PreviewService.handle(svc, event({ action: "update" }));
		expect(preview.updates[0]).toMatchObject(clientOnly);
	});

	test("saving the policy updates every open preview and redeploys the ones whose wall flipped", async () => {
		const walled = fakeService({ authRequired: true, id: "p1" });
		const open = fakeService({ authRequired: false, id: "p2" });
		previews = [walled.svc, open.svc];
		const redeploys: { id: string; wasRequired: boolean }[] = [];
		stub(
			DeploymentService,
			"redeployIfLoginWallChanged",
			async (svc: { id: string }, wasRequired: boolean) => {
				redeploys.push({ id: svc.id, wasRequired });
				return true;
			},
		);
		const { svc } = fakeService({ previewAccessPolicy: clientOnly });
		await PreviewService.applyAccessPolicy(svc);
		expect(walled.updates[0]).toEqual(clientOnly);
		expect(open.updates[0]).toEqual(clientOnly);
		expect(redeploys).toEqual([
			{ id: "p1", wasRequired: true },
			{ id: "p2", wasRequired: false },
		]);
	});
});

describe("preview branch filter", () => {
	test("a branch outside the filter gets no preview, and loses one it had", async () => {
		const { svc } = fakeService({
			previewBranchExclude: ["dependabot/*"],
			previewBranchInclude: ["feat*", "fix/*"],
		});
		expect(
			(await PreviewService.handle(svc, event({ branch: "chore/x" }))).status,
		).toBe("ignored");
		expect(
			(await PreviewService.handle(svc, event({ branch: "dependabot/npm" })))
				.status,
		).toBe("ignored");
		expect(enqueued).toHaveLength(0);

		existing = fakeService({ id: "old", previewBranch: "chore/x" }).svc;
		expect(
			await PreviewService.handle(svc, event({ branch: "chore/x" })),
		).toEqual({ serviceId: "old", status: "removed" });

		existing = null;
		expect(
			(await PreviewService.handle(svc, event({ branch: "feature" }))).status,
		).toBe("deployed");
	});

	test("applyBranchFilter removes only the previews the filter now leaves out", async () => {
		const { svc } = fakeService({ previewBranchExclude: ["wip/*"] });
		previews = [
			fakeService({ id: "p1", previewBranch: "wip/draft" }).svc,
			fakeService({ id: "p2", previewBranch: "feature" }).svc,
		];
		expect(await PreviewService.applyBranchFilter(svc)).toBe(1);
		expect(deleted).toEqual(["p1"]);
	});
});

describe("preview environment and volumes", () => {
	test("overrides go over the inherited env, with placeholders filled in", async () => {
		const { svc } = fakeService({
			envVars: { KEEP: "1", MODE: "prod" },
			previewEnvOverrides: {
				DB: "postgres://db/app_pr_{pr}",
				MODE: "preview-{branch}-{slug}",
			},
		});
		await PreviewService.handle(svc, event({ branch: "feat/x", number: 12 }));
		expect(created[0]?.envVars).toEqual({
			DB: "postgres://db/app_pr_12",
			KEEP: "1",
			MODE: "preview-feat/x-web-pr-12",
		});
	});

	test("without inheritance a preview only gets the overrides", async () => {
		const { svc } = fakeService({
			envVars: { SECRET: "parent-only" },
			previewEnvOverrides: { ONLY: "this" },
			previewInheritEnv: false,
		});
		await PreviewService.handle(svc, event());
		expect(created[0]?.envVars).toEqual({ ONLY: "this" });
	});

	test("copying volumes makes a seeded copy of every mount, mounted at the same path", async () => {
		const volumes: Record<string, unknown>[] = [];
		const mounts: Record<string, unknown>[] = [];
		stub(ServiceVolumeDTO, "listForService", async () => [
			{
				mount: {
					toJSON: () => ({ containerPath: "/data", readOnly: false }),
				},
				volumeKind: "volume",
				volumeName: "App Data",
				volumeSeedFrom: null,
				volumeSource: "app-data",
			},
		]);
		stub(StorageVolumeDTO, "create", async (input: Record<string, unknown>) => {
			volumes.push(input);
			return { id: "copy-1" };
		});
		stub(ServiceVolumeDTO, "attach", async (input: Record<string, unknown>) => {
			mounts.push(input);
		});
		const { svc } = fakeService({ previewCopyVolumes: true });
		await PreviewService.handle(svc, event());
		expect(volumes).toEqual([
			expect.objectContaining({
				kind: "volume",
				previewServiceId: "preview",
				seedFrom: "app-data",
				source: "homerun-web-pr-7-app-data",
			}),
		]);
		expect(mounts).toEqual([
			{
				containerPath: "/data",
				readOnly: false,
				serviceId: "preview",
				volumeId: "copy-1",
			},
		]);
	});

	test("names and placeholders", () => {
		expect(previewVolumeSource("web-pr-3", "My Data/1")).toBe(
			"homerun-web-pr-3-my-data-1",
		);
		expect(
			renderEnvOverride("{slug}:{pr}:{branch}", {
				branch: null,
				pr: 3,
				slug: "s",
			}),
		).toBe("s:3:");
	});
});

describe("PreviewService.deployImage", () => {
	const input = (overrides: Record<string, unknown> = {}) => ({
		branch: "feat/login",
		commit: SHA,
		prNumber: 7,
		tag: "pr-7",
		title: "Add login",
		...overrides,
	});

	test("creates a preview running the parent's image at the tag, like a git one", async () => {
		const volumes: Record<string, unknown>[] = [];
		stub(ServiceVolumeDTO, "listForService", async () => [
			{
				mount: { toJSON: () => ({ containerPath: "/data", readOnly: false }) },
				volumeName: "data",
				volumeSource: "app-data",
			},
		]);
		stub(
			StorageVolumeDTO,
			"create",
			async (volume: Record<string, unknown>) => {
				volumes.push(volume);
				return { id: "copy-1" };
			},
		);
		stub(ServiceVolumeDTO, "attach", async () => undefined);
		const { svc } = fakeService({
			buildSource: "image",
			envVars: { KEEP: "1" },
			image: "ghcr.io/me/app",
			previewCopyVolumes: true,
			previewDomainTemplate: "pr-{pr}.preview.io",
			previewEnvOverrides: { DB: "app_{pr}_{branch}" },
			registryUrl: "ghcr.io",
		});
		const result = await PreviewService.deployImage(svc, input());
		expect(result).toEqual({
			deploymentId: "d1",
			jobId: "j1",
			status: "deployed",
		});
		expect(created[0]).toMatchObject({
			buildSource: "image",
			domains: ["pr-7.preview.io"],
			envVars: { DB: "app_7_feat/login", KEEP: "1" },
			image: "ghcr.io/me/app",
			previewBranch: "feat/login",
			previewParentId: "parent",
			previewPrNumber: 7,
			previewPrTitle: "Add login",
			registryUrl: "ghcr.io",
			slug: "web-pr-7",
			tag: "pr-7",
		});
		expect(volumes).toHaveLength(1);
		expect(enqueued).toEqual([
			expect.objectContaining({
				gitCommit: SHA,
				trigger: "push",
				userId: "u1",
			}),
		]);
	});

	test("switches an existing preview to the new tag without copying volumes again", async () => {
		let copies = 0;
		stub(StorageVolumeDTO, "create", async () => {
			copies++;
			return { id: "copy" };
		});
		const preview = fakeService({
			buildSource: "image",
			id: "preview",
			previewBranch: "feat/login",
			previewPrTitle: "Old title",
			tag: "pr-7-old",
		});
		existing = preview.svc;
		const { svc } = fakeService({
			buildSource: "image",
			previewCopyVolumes: true,
		});
		const result = await PreviewService.deployImage(
			svc,
			input({ branch: null, commit: null, title: null }),
		);
		expect(result.status).toBe("deployed");
		expect(created).toHaveLength(0);
		expect(copies).toBe(0);
		expect(preview.updates[0]).toMatchObject({
			buildSource: "image",
			previewBranch: "feat/login",
			previewPrTitle: "Old title",
			tag: "pr-7",
		});
		expect(enqueued).toEqual([expect.objectContaining({ gitCommit: null })]);
	});

	test("refuses a branch the filter leaves out, removing the preview it had", async () => {
		const { svc } = fakeService({
			buildSource: "image",
			previewBranchInclude: ["feat/*"],
		});
		const refused = await PreviewService.deployImage(
			svc,
			input({ branch: "chore/deps" }),
		);
		expect(refused).toEqual({
			reason: "chore/deps doesn't pass this service's preview branch filter.",
			status: "ignored",
		});
		expect(created).toHaveLength(0);
		expect(enqueued).toHaveLength(0);

		existing = fakeService({ id: "old", previewBranch: "chore/deps" }).svc;
		await PreviewService.deployImage(svc, input({ branch: "chore/deps" }));
		expect(deleted).toEqual(["old"]);

		existing = null;
		const unfiltered = await PreviewService.deployImage(
			svc,
			input({ branch: null }),
		);
		expect(unfiltered.status).toBe("deployed");
	});
});
