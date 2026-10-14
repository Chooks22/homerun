import { afterEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { UptimeCheckDTO } = await import(
	"../../../src/lib/dto/uptime-check-dto"
);
const { ServiceVolumeDTO } = await import(
	"../../../src/lib/dto/service-volume-dto"
);
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { ImageVersionService } = await import(
	"../../../src/lib/services/image-version.service"
);
const { DeploymentService } = await import(
	"../../../src/lib/services/deploy.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { MonitoringService } = await import(
	"../../../src/lib/services/monitoring.service"
);
const { QueueService } = await import(
	"../../../src/lib/services/queue.service"
);
const { RevisionService } = await import(
	"../../../src/lib/services/revision.service"
);
const { requiredPermission } = await import("../../../src/lib/permissions");

const versionRoute = await import(
	"../../../src/routes/api/v1/services/[serviceId]/version/+server"
);
const pinRoute = await import(
	"../../../src/routes/api/v1/services/[serviceId]/version/pin/+server"
);
const checkRoute = await import(
	"../../../src/routes/api/v1/services/[serviceId]/version/check/+server"
);
const updateRoute = await import(
	"../../../src/routes/api/v1/services/[serviceId]/version/update/+server"
);
const serviceMonitoringRoute = await import(
	"../../../src/routes/api/v1/services/[serviceId]/monitoring/+server"
);
const monitoringRoute = await import(
	"../../../src/routes/api/v1/monitoring/+server"
);
const logsRoute = await import(
	"../../../src/routes/api/v1/system/logs/+server"
);
const containersRoute = await import(
	"../../../src/routes/api/v1/system/containers/+server"
);
const containerLogsRoute = await import(
	"../../../src/routes/api/v1/system/containers/[containerId]/logs/+server"
);
const { AppLogDTO } = await import("../../../src/lib/dto/app-log-dto");
const cleanupRoute = await import(
	"../../../src/routes/api/v1/system/docker-cleanup/+server"
);

afterEach(() => {
	restoreStubs();
});

const caller = { permissions: {}, user: { id: "u1" } };

/** A route event with the caller signed in, for the given service and body. */
function event(options: { body?: unknown; search?: string } = {}): never {
	return {
		locals: caller,
		params: { serviceId: "svc-1" },
		request: new Request("http://localhost/x", {
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			method: options.body === undefined ? "GET" : "POST",
		}),
		url: new URL(`http://localhost/x${options.search ?? ""}`),
	} as never;
}

/** A stand-in service row the version routes read and update in place. */
function fakeService(overrides: Record<string, unknown> = {}) {
	const row: Record<string, unknown> = {
		buildSource: "image",
		id: "svc-1",
		image: "nginx",
		pinnedFromTag: null,
		pinnedLocally: false,
		previewParentId: null,
		pullPolicy: "always",
		tag: "latest",
		updateCheck: null,
		updateCheckEnabled: false,
		updateTrialEnabled: true,
		...overrides,
	};
	const svc = {
		get buildSource() {
			return row.buildSource;
		},
		id: "svc-1",
		get image() {
			return row.image;
		},
		get tag() {
			return row.tag;
		},
		toJSON: () => row,
		update: async (patch: Record<string, unknown>) => {
			Object.assign(row, patch);
		},
	};
	stub(ServiceDTO, "get", async (id: string) => (id === "svc-1" ? svc : null));
	return row;
}

describe("a service's version routes", () => {
	test("read the pin and the last check flat", async () => {
		fakeService({
			pinnedFromTag: "latest",
			tag: "1.25.0",
			updateCheck: {
				available: { digest: "sha256:a", foundAt: "t1", tag: "1.25.1" },
				checkedAt: "t0",
				error: null,
				notifiedKey: null,
				trial: { at: "t2", message: "ok", status: "passed", tag: "1.25.1" },
			},
			updateCheckEnabled: true,
		});
		const res = await versionRoute.GET(event());
		expect(await res.json()).toEqual({
			availableDigest: "sha256:a",
			availableFoundAt: "t1",
			availableTag: "1.25.1",
			checkError: null,
			checkedAt: "t0",
			id: "svc-1",
			image: "nginx",
			pinned: true,
			pinnedFromTag: "latest",
			pinnedLocally: false,
			tag: "1.25.0",
			trialAt: "t2",
			trialMessage: "ok",
			trialStatus: "passed",
			trialTag: "1.25.1",
			updateCheckEnabled: true,
			updateTrialEnabled: true,
		});
	});

	test("refuse a git service, a preview and an unknown one", async () => {
		fakeService({ buildSource: "git" });
		expect((await versionRoute.GET(event())).status).toBe(400);
		fakeService({ previewParentId: "parent" });
		expect((await pinRoute.DELETE(event())).status).toBe(400);
		stub(ServiceDTO, "get", async () => null);
		expect((await checkRoute.POST(event())).status).toBe(404);
	});

	test("turning the watch off forgets the last check, turning it on checks", async () => {
		const row = fakeService({
			updateCheck: { available: null, checkedAt: "t0" },
			updateCheckEnabled: true,
		});
		const off = await versionRoute.PATCH(
			event({ body: { updateCheckEnabled: false } }),
		);
		expect(off.status).toBe(200);
		expect(row.updateCheck).toBeNull();
		expect(row.updateTrialEnabled).toBe(true);

		let checked = 0;
		stub(ImageVersionService, "check", async () => {
			checked += 1;
			return null;
		});
		await versionRoute.PATCH(
			event({ body: { updateCheckEnabled: true, updateTrialEnabled: false } }),
		);
		expect(checked).toBe(1);
		expect(row.updateTrialEnabled).toBe(false);
		expect((await versionRoute.PATCH(event({ body: {} }))).status).toBe(400);
	});

	test("pin to a registry tag and unpin back to the floating one", async () => {
		const row = fakeService();
		const pinned = await pinRoute.POST(event({ body: { tag: "1.25.3" } }));
		expect(pinned.status).toBe(200);
		expect(row).toMatchObject({ pinnedFromTag: "latest", tag: "1.25.3" });
		expect(
			(await pinRoute.POST(event({ body: { tag: "no good" } }))).status,
		).toBe(400);
		const unpinned = await pinRoute.DELETE(event());
		expect(await unpinned.json()).toMatchObject({
			pinned: false,
			tag: "latest",
		});
	});

	test("list the pin candidates", async () => {
		fakeService();
		stub(ImageVersionService, "findPinCandidates", async () => ({
			digest: "sha256:a",
			matches: ["1.25.3"],
			suggestion: "1.25.3",
		}));
		const res = await pinRoute.GET(event());
		expect(await res.json()).toEqual({
			digest: "sha256:a",
			matches: ["1.25.3"],
			suggestion: "1.25.3",
		});
	});

	test("a registry failure on check is a 502", async () => {
		fakeService();
		stub(ImageVersionService, "check", async () => ({ error: "timeout" }));
		const res = await checkRoute.POST(event());
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "timeout" });
	});

	test("apply the update found, or 409 without one", async () => {
		const row = fakeService();
		expect((await updateRoute.POST(event())).status).toBe(409);
		row.updateCheck = {
			available: { digest: null, foundAt: "t1", tag: "1.26.0" },
			checkedAt: "t0",
		};
		const deploys: unknown[] = [];
		stub(DeploymentService, "enqueueDeploy", async (input: unknown) => {
			deploys.push(input);
		});
		const res = await updateRoute.POST(event());
		expect(res.status).toBe(202);
		expect(row.tag).toBe("1.26.0");
		expect(deploys).toHaveLength(1);
	});
});

describe("a service's monitoring route", () => {
	test("returns the totals and the uptime beats, without the chart series", async () => {
		fakeService();
		stub(ServiceDTO, "get", async () => ({ id: "svc-1", uptimeEnabled: true }));
		stub(MonitoringService, "forService", async () => ({
			availability: {},
			bucketSeconds: 60,
			range: "week",
			resourceSeries: [1],
			trafficSeries: [1],
		}));
		stub(UptimeCheckDTO, "beats", async (_id: string, kind: string) => [
			{ kind, ok: true, serviceId: "svc-1" },
		]);
		const res = await serviceMonitoringRoute.GET(event());
		expect(await res.json()).toEqual({
			availability: {},
			range: "week",
			uptime: {
				external: [{ kind: "external", ok: true }],
				internal: [{ kind: "internal", ok: true }],
			},
			uptimeEnabled: true,
		});
		const bad = await serviceMonitoringRoute.GET(
			event({ search: "?range=decade" }),
		);
		expect(bad.status).toBe(400);
	});
});

describe("the instance monitoring and system log routes", () => {
	test("monitoring names each service in the breakdown", async () => {
		stub(ServiceDTO, "list", async () => [{ id: "svc-1", name: "Web" }]);
		stub(MonitoringService, "forScope", async () => ({
			bucketSeconds: 60,
			range: "today",
			resourceSeries: [],
			trafficSeries: [],
		}));
		stub(MonitoringService, "breakdown", async () => [
			{ requests: 3, serviceId: "svc-1" },
			{ requests: 0, serviceId: "gone" },
		]);
		const res = await monitoringRoute.GET(event({ search: "?range=today" }));
		expect(await res.json()).toEqual({
			range: "today",
			services: [
				{ name: "Web", requests: 3, serviceId: "svc-1" },
				{ name: "gone", requests: 0, serviceId: "gone" },
			],
		});
		const bad = await monitoringRoute.GET(event({ search: "?zone=Mars/Base" }));
		expect(bad.status).toBe(400);
	});

	test("the system log names each entry's service and bounds the limit", async () => {
		stub(AppLogDTO, "listRecent", async () => [
			{ toJSON: () => ({ id: "l1", serviceId: "svc-1" }) },
			{ toJSON: () => ({ id: "l2", serviceId: null }) },
		]);
		stub(ServiceDTO, "list", async () => [{ id: "svc-1", name: "Web" }]);
		const res = await logsRoute.GET(event());
		expect(await res.json()).toEqual([
			{ id: "l1", serviceId: "svc-1", serviceName: "Web" },
			{ id: "l2", serviceId: null, serviceName: null },
		]);
		expect((await logsRoute.GET(event({ search: "?limit=0" }))).status).toBe(
			400,
		);
	});

	test("only the instance's own containers' logs can be read", async () => {
		stub(DockerService, "listInfraContainers", async () => [{ id: "traefik" }]);
		stub(
			DockerService,
			"streamLogs",
			async () => new Response("\u001b[32mready\u001b[0m\n").body,
		);
		expect(await (await containersRoute.GET(event())).json()).toEqual([
			{ id: "traefik" },
		]);
		const logs = await containerLogsRoute.GET({
			...(event() as object),
			params: { containerId: "traefik" },
		} as never);
		expect(await logs.text()).toBe("ready\n");
		const other = await containerLogsRoute.GET({
			...(event() as object),
			params: { containerId: "someone-elses" },
		} as never);
		expect(other.status).toBe(404);
		const bad = await containerLogsRoute.GET({
			...(event({ search: "?tail=abc" }) as object),
			params: { containerId: "traefik" },
		} as never);
		expect(bad.status).toBe(400);
	});

	test("a signed-out caller gets a 401", async () => {
		const res = await logsRoute.GET({
			locals: { user: null },
			url: new URL("http://localhost/x"),
		} as never);
		expect(res.status).toBe(401);
	});
});

describe("the Docker cleanup route", () => {
	test("previews with what services keep left out", async () => {
		stub(RevisionService, "retainedImageIds", async () => ["img-keep"]);
		stub(ServiceVolumeDTO, "mountedVolumeNames", async () => ["data"]);
		stub(StackDTO, "allIds", async () => ["stack-1"]);
		let kept: unknown[] = [];
		stub(
			DockerService,
			"getCleanupPreview",
			async (images: string[], volumes: string[]) => {
				kept = [images, volumes];
				return { images: { items: [], totalCount: 0 } };
			},
		);
		stub(DockerService, "findOrphanStackNetworks", async () => []);
		const res = await cleanupRoute.GET(event());
		expect(await res.json()).toEqual({
			images: { items: [], totalCount: 0 },
			orphanStackNetworks: [],
		});
		expect(kept).toEqual([["img-keep"], ["data"]]);
	});

	test("queues a prune as an exclusive job", async () => {
		const queued: Record<string, unknown>[] = [];
		stub(QueueService, "enqueue", async (input: Record<string, unknown>) => {
			queued.push(input);
			return { id: "job-1" };
		});
		const res = await cleanupRoute.POST(
			event({ body: { action: "pruneImages", all: true } }),
		);
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ action: "pruneImages", jobId: "job-1" });
		expect(queued[0]).toMatchObject({
			exclusive: true,
			payload: { action: "pruneImages", all: true },
			type: "docker_cleanup",
		});
		const bad = await cleanupRoute.POST(event({ body: { action: "rm -rf" } }));
		expect(bad.status).toBe(400);
	});
});

describe("the service PATCH body", () => {
	test("takes the update watch settings", async () => {
		const { updateServiceApiBody } = await import(
			"../../../src/lib/server/validation/api"
		);
		expect(
			updateServiceApiBody.parse({
				updateCheckEnabled: true,
				updateTrialEnabled: false,
			}),
		).toEqual({ updateCheckEnabled: true, updateTrialEnabled: false });
	});
});

describe("the new REST routes' permission areas", () => {
	test("system routes need System, monitoring needs Services", () => {
		expect(requiredPermission("GET", "/api/v1/system/logs")).toEqual({
			area: "system",
			level: "read",
		});
		expect(requiredPermission("POST", "/api/v1/system/docker-cleanup")).toEqual(
			{ area: "system", level: "write" },
		);
		expect(requiredPermission("GET", "/api/v1/monitoring")).toEqual({
			area: "services",
			level: "read",
		});
		expect(
			requiredPermission("POST", "/api/v1/services/[serviceId]/version/pin"),
		).toEqual({ area: "services", level: "write" });
	});
});
