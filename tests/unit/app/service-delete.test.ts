import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

let removeError: unknown = null;
const removed: string[] = [];
const dockerCalls: unknown[][] = [];
let imageIds: (string | null)[] = [];

function record(name: string) {
	return async (...args: unknown[]) => {
		dockerCalls.push([name, ...args]);
		return name === "inspectStatus" ? "running" : undefined;
	};
}

const fakeDocker: Record<string, unknown> = {
	buildAuthConfig: () => ({ password: "p", username: "u" }),
	inspectStatus: record("inspectStatus"),
	killContainer: record("killContainer"),
	localImageId: async () => imageIds.shift() ?? null,
	pullImage: record("pullImage"),
	removeContainer: async (id: string, ...rest: unknown[]) => {
		dockerCalls.push(["removeContainer", id, ...rest]);
		if (removeError) {
			throw removeError;
		}
		removed.push(id);
	},
	removeSwarmService: async (id: string) => {
		if (removeError) {
			throw removeError;
		}
		removed.push(id);
	},
	restartContainer: record("restartContainer"),
	restartSwarmService: record("restartSwarmService"),
	scaleSwarmService: record("scaleSwarmService"),
	startContainer: record("startContainer"),
	stopContainer: record("stopContainer"),
	streamLogs: record("streamLogs"),
};

const webhooksRemoved: string[] = [];
let activeJobs: { id: string; title: string }[] = [];
const cancelledJobs: string[] = [];
const dependencies = new Map<string, string[]>();
const servicesById = new Map<string, unknown>();
const previewsByParent = new Map<string, unknown[]>();

const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { DomainDnsService } = await import(
	"../../../src/lib/services/domain-dns.service"
);
const { PangolinService } = await import(
	"../../../src/lib/services/pangolin.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { GitWebhookService } = await import(
	"../../../src/lib/services/git-webhook.service"
);
const { ServiceGitDTO } = await import("../../../src/lib/dto/service-git-dto");
const { JobDTO } = await import("../../../src/lib/dto/job-dto");
const { StorageVolumeDTO } = await import(
	"../../../src/lib/dto/storage-volume-dto"
);
const { ServiceDependencyDTO } = await import(
	"../../../src/lib/dto/service-dependency-dto"
);
const { ServiceLifecycleService, StackBusyError } = await import(
	"../../../src/lib/services/service-lifecycle.service"
);
const { removalFailure, tryRemoveWorkload, WorkloadDetachError } = await import(
	"../../../src/lib/services/docker/workload-removal"
);

type Svc = Parameters<typeof ServiceLifecycleService.deleteService>[0];

function fakeService(overrides: Partial<Record<string, unknown>> = {}) {
	const state = { deleted: false, updates: [] as unknown[] };
	const svc = {
		containerId: "c1",
		defaultDomainEnabled: true,
		delete: async () => {
			state.deleted = true;
		},
		dnsResolvable: false,
		domains: [] as string[],
		replicas: 0,
		slug: "web",
		stackId: null,
		toJSON() {
			return this;
		},
		update: async (patch: unknown) => {
			state.updates.push(patch);
		},
		id: "s1",
		name: "web",
		swarmServiceId: null,
		...overrides,
	};
	return { state, svc: svc as unknown as Svc };
}

function dockerError(statusCode: number, message: string) {
	return Object.assign(new Error(message), { statusCode });
}

const dnsDeletes: string[] = [];
let otherServices: Svc[] = [];
let dnsFailure: unknown = null;
const warnings: string[] = [];
const originalBaseDomain = config.baseDomain;

beforeEach(() => {
	removeError = null;
	removed.length = 0;
	dockerCalls.length = 0;
	dnsDeletes.length = 0;
	dnsFailure = null;
	warnings.length = 0;
	config.baseDomain = "example.com";
	for (const [key, impl] of Object.entries(fakeDocker)) {
		stub(DockerService, key, impl);
	}
	stub(GitWebhookService, "remove", async (svc: { id: string }) => {
		webhooksRemoved.push(svc.id);
	});
	stub(
		ServiceGitDTO,
		"listChildren",
		async (parentId: string) => previewsByParent.get(parentId) ?? [],
	);
	stub(DomainDnsService, "deleteHostname", async (host: string) => {
		if (dnsFailure) {
			throw dnsFailure;
		}
		dnsDeletes.push(host);
		return null;
	});
	stub(PangolinService, "deleteDnsRecord", async () => null);
	otherServices = [];
	stub(ServiceDTO, "list", async () => otherServices);
	stub(StackDTO, "list", async () => []);
	stub(Logger.prototype, "warn", (message: string) => {
		warnings.push(message);
	});
	stub(
		ServiceDependencyDTO,
		"listForService",
		async (id: string) => dependencies.get(id) ?? [],
	);
	stub(ServiceDTO, "get", async (id: string) => servicesById.get(id) ?? null);
	stub(JobDTO, "listActiveForServices", async () => activeJobs);
	stub(JobDTO, "cancel", async (id: string) => {
		cancelledJobs.push(id);
		return [];
	});
	activeJobs = [];
	cancelledJobs.length = 0;
	webhooksRemoved.length = 0;
	previewsByParent.clear();
	dependencies.clear();
	servicesById.clear();
});

afterEach(() => {
	config.baseDomain = originalBaseDomain;
	restoreStubs();
});

describe("removalFailure", () => {
	test("a 404 means already gone, not a failure", () => {
		expect(removalFailure(dockerError(404, "no such container"))).toBeNull();
	});

	test("anything else is reported", () => {
		expect(removalFailure(dockerError(500, "daemon exploded"))).toBe(
			"daemon exploded",
		);
		expect(removalFailure("socket closed")).toBe("socket closed");
	});

	test("tryRemoveWorkload returns null on success", async () => {
		expect(await tryRemoveWorkload(async () => {})).toBeNull();
	});
});

describe("ServiceLifecycleService.deleteService", () => {
	test("removes the container, the webhook and the row", async () => {
		const { state, svc } = fakeService();
		await ServiceLifecycleService.deleteService(svc);
		expect(removed).toEqual(["c1"]);
		expect(webhooksRemoved).toEqual(["s1"]);
		expect(state.deleted).toBe(true);
	});

	test("a container that's already gone still deletes the row", async () => {
		removeError = dockerError(404, "no such container");
		const { state, svc } = fakeService();
		await ServiceLifecycleService.deleteService(svc);
		expect(state.deleted).toBe(true);
	});

	test("a failed removal throws and deletes nothing", async () => {
		removeError = dockerError(500, "daemon unreachable");
		const { state, svc } = fakeService({
			containerId: null,
			swarmServiceId: "sw1",
		});
		const attempt = ServiceLifecycleService.deleteService(svc);
		await expect(attempt).rejects.toBeInstanceOf(WorkloadDetachError);
		await expect(attempt).rejects.toThrow(/swarm service.*daemon unreachable/);
		expect(state.deleted).toBe(false);
		expect(webhooksRemoved).toEqual([]);
	});

	test("force deletes the row despite a failed removal", async () => {
		removeError = dockerError(500, "daemon unreachable");
		const { state, svc } = fakeService();
		await ServiceLifecycleService.deleteService(svc, { force: true });
		expect(state.deleted).toBe(true);
	});

	test("a never-deployed service just deletes the row", async () => {
		removeError = dockerError(500, "unused");
		const { state, svc } = fakeService({ containerId: null });
		await ServiceLifecycleService.deleteService(svc);
		expect(state.deleted).toBe(true);
	});

	test("removes the service's pull request previews first", async () => {
		const preview = fakeService({ containerId: "c2", id: "s2" });
		previewsByParent.set("s1", [preview.svc]);
		const { state, svc } = fakeService();
		await ServiceLifecycleService.deleteService(svc);
		expect(removed).toEqual(["c2", "c1"]);
		expect(preview.state.deleted).toBe(true);
		expect(state.deleted).toBe(true);
	});

	test("removes the release channel canary before the service", async () => {
		const canary = fakeService({
			channelCanary: true,
			containerId: "c3",
			id: "s3",
		});
		previewsByParent.set("s1", [canary.svc]);
		const { state, svc } = fakeService();
		await ServiceLifecycleService.deleteService(svc);
		expect(removed).toEqual(["c3", "c1"]);
		expect(canary.state.deleted).toBe(true);
		expect(state.deleted).toBe(true);
	});
});

describe("ServiceLifecycleService container passthroughs", () => {
	test("each one forwards the container id to Docker", async () => {
		await ServiceLifecycleService.start("c1");
		await ServiceLifecycleService.stop("c1");
		await ServiceLifecycleService.restart("c1");
		await ServiceLifecycleService.remove("c1");
		expect(await ServiceLifecycleService.status("c1")).toBe("running");
		await ServiceLifecycleService.streamLogs("c1");

		expect(dockerCalls).toEqual([
			["startContainer", "c1"],
			["stopContainer", "c1"],
			["restartContainer", "c1"],
			["removeContainer", "c1", { force: true }],
			["inspectStatus", "c1"],
			["streamLogs", "c1", { follow: true, tail: 200 }],
		]);
	});
});

describe("ServiceLifecycleService start/stop/restart", () => {
	test("startService starts the container, then marks it running", async () => {
		const { state, svc } = fakeService();
		await ServiceLifecycleService.startService(svc);
		expect(dockerCalls).toEqual([["startContainer", "c1"]]);
		expect(state.updates).toEqual([{ desiredState: "running" }]);
	});

	test("startService starts stopped dependencies first, once, and skips running or undeployed ones", async () => {
		const db = fakeService({ containerId: "db1", id: "db", name: "db" });
		const cache = fakeService({
			containerId: null,
			id: "cache",
			name: "cache",
		});
		const api = fakeService({ containerId: "api1", id: "api", name: "api" });
		const app = fakeService({ containerId: "app1", id: "app", name: "app" });
		for (const { svc } of [db, cache, api, app]) {
			servicesById.set((svc as unknown as { id: string }).id, svc);
		}
		dependencies.set("app", ["api", "db", "cache"]);
		dependencies.set("api", ["db", "app"]);
		stub(DockerService, "inspectStatus", async (id: string) =>
			id === "api1" ? "stopped" : id === "db1" ? "stopped" : "running",
		);

		await ServiceLifecycleService.startService(app.svc);

		expect(dockerCalls).toEqual([
			["startContainer", "db1"],
			["startContainer", "api1"],
			["startContainer", "app1"],
		]);
		expect(cache.state.updates).toEqual([]);
	});

	test("a dependency that fails to start fails the start, naming it", async () => {
		const db = fakeService({ containerId: "db1", id: "db", name: "db" });
		servicesById.set("db", db.svc);
		dependencies.set("s1", ["db"]);
		stub(DockerService, "inspectStatus", async () => "stopped");
		stub(DockerService, "startContainer", async () => {
			throw new Error("boom");
		});
		const { state, svc } = fakeService();

		await expect(ServiceLifecycleService.startService(svc)).rejects.toThrow(
			"Couldn't start db, which web depends on: boom",
		);
		expect(state.updates).toEqual([]);
	});

	test("startService scales a swarm service to its replicas, at least 1", async () => {
		const one = fakeService({ swarmServiceId: "sw1" });
		await ServiceLifecycleService.startService(one.svc);
		const three = fakeService({ replicas: 3, swarmServiceId: "sw3" });
		await ServiceLifecycleService.startService(three.svc);

		expect(dockerCalls).toEqual([
			["scaleSwarmService", "sw1", 1],
			["scaleSwarmService", "sw3", 3],
		]);
		expect(three.state.updates).toEqual([{ desiredState: "running" }]);
	});

	test("stopService records the stop before stopping the container", async () => {
		const { state, svc } = fakeService();
		await ServiceLifecycleService.stopService(svc);
		expect(state.updates).toEqual([{ desiredState: "stopped" }]);
		expect(dockerCalls).toEqual([["stopContainer", "c1"]]);
	});

	test("stopService scales a swarm service to 0", async () => {
		const { svc } = fakeService({ containerId: null, swarmServiceId: "sw1" });
		await ServiceLifecycleService.stopService(svc);
		expect(dockerCalls).toEqual([["scaleSwarmService", "sw1", 0]]);
	});

	test("restartService restarts the swarm service or the container", async () => {
		await ServiceLifecycleService.restartService(
			fakeService({ swarmServiceId: "sw1" }).svc,
		);
		await ServiceLifecycleService.restartService(fakeService().svc);
		expect(dockerCalls).toEqual([
			["restartSwarmService", "sw1"],
			["restartContainer", "c1"],
		]);
	});

	test("a never-deployed service can't be started, stopped or restarted, and nothing is persisted", async () => {
		const { state, svc } = fakeService({ containerId: null });
		for (const action of [
			ServiceLifecycleService.startService,
			ServiceLifecycleService.stopService,
			ServiceLifecycleService.restartService,
		]) {
			await expect(action.call(ServiceLifecycleService, svc)).rejects.toThrow(
				"This service hasn't been deployed yet.",
			);
		}
		expect(state.updates).toEqual([]);
		expect(dockerCalls).toEqual([]);
	});
});

describe("ServiceLifecycleService DNS cleanup", () => {
	test("a publicly routed service in a stack drops its stack-prefixed and custom hostnames", async () => {
		stub(StackDTO, "get", async (id: string) =>
			id === "st1" ? { slug: "shop" } : null,
		);
		const { state, svc } = fakeService({
			dnsResolvable: true,
			domains: ["shop.acme.io"],
			stackId: "st1",
		});

		await ServiceLifecycleService.deleteService(svc);

		expect(dnsDeletes).toEqual(["shop-web.example.com", "shop.acme.io"]);
		expect(state.deleted).toBe(true);
	});

	test("a domain with a path keeps the host record another service still routes", async () => {
		stub(StackDTO, "get", async () => null);
		otherServices = [
			fakeService({
				dnsResolvable: true,
				domains: ["shop.acme.io"],
				id: "front",
				slug: "front",
			}).svc,
		];
		const { svc } = fakeService({
			defaultDomainEnabled: false,
			dnsResolvable: true,
			domains: ["shop.acme.io/api", "api.acme.io/v1"],
		});

		await ServiceLifecycleService.deleteService(svc);

		expect(dnsDeletes).toEqual(["api.acme.io"]);
	});

	test("a DNS provider failure doesn't block the delete or surface as a warning", async () => {
		dnsFailure = new Error("boom");
		stub(StackDTO, "get", async () => null);
		const { state, svc } = fakeService({ dnsResolvable: true });

		await ServiceLifecycleService.deleteService(svc);

		expect(state.deleted).toBe(true);
		expect(warnings).toEqual([]);
	});
});

describe("ServiceLifecycleService.deleteStack", () => {
	test("cascades the stack delete, then cleans up each member's webhook and DNS under the stack slug", async () => {
		const api = fakeService({ dnsResolvable: true, id: "api", slug: "api" });
		const worker = fakeService({ id: "worker", slug: "worker" });
		const cascades: unknown[] = [];
		stub(ServiceDTO, "listByStack", async (id: string) =>
			id === "st1" ? [api.svc, worker.svc] : [],
		);
		const stack = {
			cascadeDelete: async (options: unknown) => {
				cascades.push(options);
				expect(webhooksRemoved).toEqual([]);
			},
			id: "st1",
			slug: "shop",
		} as unknown as Parameters<typeof ServiceLifecycleService.deleteStack>[0];

		await ServiceLifecycleService.deleteStack(stack, { force: true });

		expect(cascades).toEqual([{ force: true }]);
		expect(webhooksRemoved.sort((a, b) => a.localeCompare(b))).toEqual([
			"api",
			"worker",
		]);
		expect(dnsDeletes).toEqual(["shop-api.example.com"]);
	});

	test("a member with a running job refuses the delete without touching anything", async () => {
		stub(ServiceDTO, "listByStack", async () => [fakeService().svc]);
		activeJobs = [{ id: "j1", title: "Deploy web" }];
		let cascaded = false;
		const stack = {
			cascadeDelete: async () => {
				cascaded = true;
			},
			id: "st1",
			name: "shop",
			slug: "shop",
		} as unknown as Parameters<typeof ServiceLifecycleService.deleteStack>[0];

		await expect(ServiceLifecycleService.deleteStack(stack)).rejects.toThrow(
			StackBusyError,
		);
		expect(cascaded).toBe(false);
		expect(cancelledJobs).toEqual([]);
	});

	test("force cancels the running jobs before cascading", async () => {
		stub(ServiceDTO, "listByStack", async () => [fakeService().svc]);
		activeJobs = [{ id: "j1", title: "Deploy web" }];
		const stack = {
			cascadeDelete: async () => {
				expect(cancelledJobs).toEqual(["j1"]);
			},
			id: "st1",
			name: "shop",
			slug: "shop",
		} as unknown as Parameters<typeof ServiceLifecycleService.deleteStack>[0];

		await ServiceLifecycleService.deleteStack(stack, { force: true });
		expect(cancelledJobs).toEqual(["j1"]);
	});

	test("deleteVolumes removes the volumes only the stack's services mount", async () => {
		const api = fakeService({ id: "api" });
		const worker = fakeService({ id: "worker" });
		stub(ServiceDTO, "listByStack", async () => [api.svc, worker.svc]);
		const deletedRows: string[] = [];
		const removedVolumes: string[] = [];
		let asked: string[] = [];
		stub(StorageVolumeDTO, "listExclusiveTo", async (ids: string[]) => {
			asked = ids;
			return [
				{
					delete: async () => deletedRows.push("data"),
					kind: "volume",
					source: "homerun-data",
				},
				{
					delete: async () => deletedRows.push("host"),
					kind: "bind",
					source: "/srv/host",
				},
			];
		});
		stub(DockerService, "removeVolume", async (name: string) => {
			removedVolumes.push(name);
		});
		const stack = {
			cascadeDelete: async () => {},
			id: "st1",
			name: "shop",
			slug: "shop",
		} as unknown as Parameters<typeof ServiceLifecycleService.deleteStack>[0];

		await ServiceLifecycleService.deleteStack(stack, { deleteVolumes: true });
		expect(asked).toEqual(["api", "worker"]);
		expect(deletedRows).toEqual(["data", "host"]);
		expect(removedVolumes).toEqual(["homerun-data"]);
	});

	test("a failed cascade leaves webhooks and DNS alone", async () => {
		stub(ServiceDTO, "listByStack", async () => [fakeService().svc]);
		const stack = {
			cascadeDelete: async () => {
				throw new WorkloadDetachError("nope");
			},
			id: "st1",
			slug: "shop",
		} as unknown as Parameters<typeof ServiceLifecycleService.deleteStack>[0];

		await expect(ServiceLifecycleService.deleteStack(stack)).rejects.toThrow(
			"nope",
		);
		expect(webhooksRemoved).toEqual([]);
		expect(dnsDeletes).toEqual([]);
	});
});

describe("ServiceLifecycleService kill/pull", () => {
	test("killService records the stop before killing the container", async () => {
		const { state, svc } = fakeService();
		await ServiceLifecycleService.killService(svc);
		expect(state.updates).toEqual([{ desiredState: "stopped" }]);
		expect(dockerCalls).toEqual([["killContainer", "c1"]]);
	});

	test("killService refuses a swarm service", async () => {
		const { svc } = fakeService({ containerId: null, swarmServiceId: "sw1" });
		await expect(ServiceLifecycleService.killService(svc)).rejects.toThrow(
			"can't be killed",
		);
		expect(dockerCalls).toEqual([]);
	});

	test("pullServiceImage pulls with the service's credentials and reports a change", async () => {
		const { svc } = fakeService({ image: "nginx", tag: "latest" });
		imageIds = ["sha256:old", "sha256:new"];
		expect(await ServiceLifecycleService.pullServiceImage(svc)).toEqual({
			changed: true,
		});
		expect(dockerCalls).toEqual([
			[
				"pullImage",
				{
					auth: { password: "p", username: "u" },
					image: "nginx",
					tag: "latest",
				},
			],
		]);

		imageIds = ["sha256:same", "sha256:same"];
		expect(await ServiceLifecycleService.pullServiceImage(svc)).toEqual({
			changed: false,
		});
	});

	test("pullServiceImage refuses a git service", async () => {
		const { svc } = fakeService({ buildSource: "git" });
		await expect(ServiceLifecycleService.pullServiceImage(svc)).rejects.toThrow(
			"builds from git",
		);
	});
});

describe("deleting a preview", () => {
	test("removes the volumes it copied, even when one can't be removed", async () => {
		const attempted: string[] = [];
		stub(StorageVolumeDTO, "listForPreview", async () => [
			{ source: "homerun-web-pr-1-a" },
			{ source: "homerun-web-pr-1-b" },
		]);
		stub(DockerService, "removeVolume", async (name: string) => {
			attempted.push(name);
			if (name.endsWith("-a")) {
				throw new Error("volume in use");
			}
		});
		const { state, svc } = fakeService({
			containerId: null,
			id: "p1",
			previewParentId: "s1",
		});
		await ServiceLifecycleService.deleteService(svc);
		expect(attempted).toEqual(["homerun-web-pr-1-a", "homerun-web-pr-1-b"]);
		expect(state.deleted).toBe(true);
	});
});
