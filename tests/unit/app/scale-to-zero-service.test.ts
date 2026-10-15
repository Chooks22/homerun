import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { JobDTO } = await import("../../../src/lib/dto/job-dto");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { TrafficSampleDTO } = await import(
	"../../../src/lib/dto/traffic-sample-dto"
);
const { ERROR_PAGES_FILE } = await import(
	"../../../src/lib/services/docker/error-pages"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { ServiceLifecycleService } = await import(
	"../../../src/lib/services/service-lifecycle.service"
);
const { ScaleToZeroService } = await import(
	"../../../src/lib/services/scale-to-zero.service"
);

interface Row {
	containerId: string | null;
	currentStatus: string;
	desiredState: string;
	dnsResolvable: boolean;
	id: string;
	networkMode: string;
	scaleToZeroMinutes: number | null;
	sleepingSince: Date | null;
	swarmServiceId: string | null;
	wokenAt: Date | null;
}

type FakeService = Row & {
	toJSON(): Row;
	update(input: Partial<Row>): Promise<void>;
	updates: Partial<Row>[];
};

const now = new Date("2026-10-15T12:00:00Z");
const longAgo = new Date(now.getTime() - 3_600_000);

function fake(overrides: Partial<Row> = {}): FakeService {
	const svc: FakeService = {
		containerId: "c1",
		currentStatus: "running",
		desiredState: "running",
		dnsResolvable: true,
		id: "svc-1",
		networkMode: "bridge",
		scaleToZeroMinutes: 15,
		sleepingSince: null,
		swarmServiceId: null,
		wokenAt: longAgo,
		...overrides,
		toJSON() {
			return svc;
		},
		update(input) {
			svc.updates.push(input);
			Object.assign(svc, input);
			return Promise.resolve();
		},
		updates: [],
	};
	return svc;
}

let directory: string;
const realDir = config.traefik.dynamicConfigDir;
let calls: string[];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "homerun-scale-to-zero-"));
	await writeFile(join(directory, ERROR_PAGES_FILE), "");
	config.traefik.dynamicConfigDir = directory;
	calls = [];
	stub(Bun, "sleep", () => Promise.resolve());
	stub(TrafficSampleDTO, "lastRequestAt", () => Promise.resolve(new Map()));
	stub(JobDTO, "listActiveForServices", () => Promise.resolve([]));
	stub(ServiceLifecycleService, "stopService", (svc: FakeService) => {
		calls.push(`stop:${svc.id}`);
		return svc.update({ desiredState: "stopped", sleepingSince: null });
	});
	stub(ServiceLifecycleService, "startService", (svc: FakeService) => {
		calls.push(`start:${svc.id}`);
		return svc.update({ desiredState: "running" });
	});
	stub(DockerService, "inspectStatus", () => Promise.resolve("running"));
	stub(DockerService, "containerHealth", () => Promise.resolve(null));
	stub(DockerService, "inspectSwarmServiceStatus", () =>
		Promise.resolve("running"),
	);
});

afterEach(async () => {
	restoreStubs();
	config.traefik.dynamicConfigDir = realDir;
	await rm(directory, { force: true, recursive: true });
});

function listing(services: FakeService[]) {
	stub(ServiceDTO, "listScaleToZero", () => Promise.resolve(services));
}

describe("ScaleToZeroService.sleepIdle", () => {
	test("puts a service idle past its minutes to sleep", async () => {
		const svc = fake();
		listing([svc]);
		await ScaleToZeroService.sleepIdle(now, longAgo);
		expect(calls).toEqual(["stop:svc-1"]);
		expect(svc.sleepingSince).toBeInstanceOf(Date);
		expect(svc.currentStatus).toBe("stopped");
	});

	test("leaves alone a service with a recent request", async () => {
		const svc = fake();
		listing([svc]);
		stub(TrafficSampleDTO, "lastRequestAt", () =>
			Promise.resolve(new Map([["svc-1", new Date(now.getTime() - 60_000)]])),
		);
		await ScaleToZeroService.sleepIdle(now, longAgo);
		expect(calls).toEqual([]);
	});

	test("skips a service with a job running, no routing, host networking or a hand stop", async () => {
		const busy = fake({ id: "busy" });
		listing([
			busy,
			fake({ dnsResolvable: false, id: "unrouted" }),
			fake({ id: "host", networkMode: "host" }),
			fake({ desiredState: "stopped", id: "stopped" }),
			fake({ id: "off", scaleToZeroMinutes: null }),
		]);
		stub(JobDTO, "listActiveForServices", () =>
			Promise.resolve([{ id: "job", serviceId: "busy", title: "Deploy" }]),
		);
		await ScaleToZeroService.sleepIdle(now, longAgo);
		expect(calls).toEqual([]);
	});

	test("does nothing while the error pages aren't published", async () => {
		listing([fake()]);
		config.traefik.dynamicConfigDir = undefined;
		await ScaleToZeroService.sleepIdle(now, longAgo);
		expect(calls).toEqual([]);
	});

	test("marks awake a sleeping service the status sync found running", async () => {
		const svc = fake({
			desiredState: "stopped",
			sleepingSince: longAgo,
			wokenAt: null,
		});
		listing([svc]);
		await ScaleToZeroService.sleepIdle(now, longAgo);
		expect(svc.sleepingSince).toBeNull();
		expect(svc.desiredState).toBe("running");
		expect(svc.wokenAt).toBeInstanceOf(Date);
		expect(calls).toEqual([]);
	});

	test("a failed stop is logged, not thrown", async () => {
		listing([fake()]);
		stub(ServiceLifecycleService, "stopService", () =>
			Promise.reject(new Error("daemon gone")),
		);
		await ScaleToZeroService.sleepIdle(now, longAgo);
	});
});

describe("ScaleToZeroService.wake", () => {
	test("starts a sleeping service and waits for it to be healthy", async () => {
		const svc = fake({
			currentStatus: "stopped",
			desiredState: "stopped",
			sleepingSince: longAgo,
		});
		stub(ServiceDTO, "get", () => Promise.resolve(svc));
		let checks = 0;
		stub(DockerService, "containerHealth", () => {
			checks += 1;
			return Promise.resolve({
				output: null,
				status: checks < 3 ? "starting" : "healthy",
			});
		});
		const wake = ScaleToZeroService.wake(svc as never);
		expect(ScaleToZeroService.isWaking("svc-1")).toBe(true);
		expect(ScaleToZeroService.wake(svc as never)).toBe(wake);
		expect(await wake).toBe(true);
		expect(calls).toEqual(["start:svc-1"]);
		expect(checks).toBe(3);
		expect(svc.sleepingSince).toBeNull();
		expect(svc.currentStatus).toBe("running");
		expect(ScaleToZeroService.isWaking("svc-1")).toBe(false);
	});

	test("waits on the swarm service's tasks in swarm mode", async () => {
		const svc = fake({
			containerId: null,
			sleepingSince: longAgo,
			swarmServiceId: "sw1",
		});
		stub(ServiceDTO, "get", () => Promise.resolve(svc));
		const statuses = ["starting", "running"];
		stub(DockerService, "inspectSwarmServiceStatus", () =>
			Promise.resolve(statuses.shift() ?? "running"),
		);
		expect(await ScaleToZeroService.wake(svc as never)).toBe(true);
		expect(statuses).toEqual([]);
	});

	test("a failed start puts it back to sleep", async () => {
		const svc = fake({ sleepingSince: longAgo });
		stub(ServiceDTO, "get", () => Promise.resolve(svc));
		stub(ServiceLifecycleService, "startService", () =>
			Promise.reject(new Error("no such image")),
		);
		expect(await ScaleToZeroService.wake(svc as never)).toBe(false);
		expect(svc.sleepingSince).toEqual(longAgo);
	});

	test("gives up when it never turns ready", async () => {
		const svc = fake({ containerId: null, sleepingSince: longAgo });
		stub(ServiceDTO, "get", () => Promise.resolve(svc));
		let clock = now.getTime();
		stub(Date, "now", () => {
			clock += 30_000;
			return clock;
		});
		expect(await ScaleToZeroService.wake(svc as never)).toBe(false);
	});

	test("a service deleted meanwhile doesn't wake", async () => {
		stub(ServiceDTO, "get", () => Promise.resolve(null));
		expect(await ScaleToZeroService.wake(fake() as never)).toBe(false);
	});
});

describe("ScaleToZeroService.configured", () => {
	test("turning it on starts the idle clock now", async () => {
		const svc = fake({ wokenAt: null });
		await ScaleToZeroService.configured(svc as never, null);
		expect(svc.wokenAt).toBeInstanceOf(Date);
	});

	test("turning it off while asleep wakes the service", async () => {
		const svc = fake({ scaleToZeroMinutes: null, sleepingSince: longAgo });
		stub(ServiceDTO, "get", () => Promise.resolve(svc));
		await ScaleToZeroService.configured(svc as never, 15);
		await ScaleToZeroService.wake(svc as never);
		expect(calls).toEqual(["start:svc-1"]);
	});
});
