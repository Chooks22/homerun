import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	bucketSecondsFor,
	isMonitoringRange,
	isTimeZone,
	rangeStart,
	startOfDay,
} = await import("../../../src/lib/monitoring-ranges");
const {
	counterDelta,
	countersBySlug,
	parseTraefikMetrics,
	slugForTraefikService,
} = await import("../../../src/lib/traffic-metrics");
const { MonitoringService, padBuckets } = await import(
	"../../../src/lib/services/monitoring.service"
);
const { StatsSampler } = await import(
	"../../../src/lib/services/stats/stats-sampler"
);
const { StatSampleDTO } = await import("../../../src/lib/dto/stat-sample-dto");
const { TrafficSampleDTO } = await import(
	"../../../src/lib/dto/traffic-sample-dto"
);
const { UptimeCheckDTO } = await import(
	"../../../src/lib/dto/uptime-check-dto"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { SystemStatsService } = await import(
	"../../../src/lib/services/system-stats.service"
);
const { CapacityService } = await import(
	"../../../src/lib/services/capacity.service"
);
const { Logger } = await import("../../../src/lib/logger");

const METRICS = `# HELP traefik_service_requests_total How many HTTP requests processed.
traefik_service_requests_total{code="200",method="GET",protocol="http",service="web@docker"} 90
traefik_service_requests_total{code="404",method="GET",protocol="http",service="web@docker"} 6
traefik_service_requests_total{code="502",method="GET",protocol="http",service="web-8080@docker"} 4
traefik_service_requests_total{code="200",method="GET",protocol="http",service="dashboard@internal"} 3
traefik_service_request_duration_seconds_sum{code="200",method="GET",protocol="http",service="web@docker"} 4.5
traefik_service_request_duration_seconds_count{code="200",method="GET",protocol="http",service="web@docker"} 90
traefik_service_requests_bytes_total{code="200",method="GET",protocol="http",service="web@docker"} 1000
traefik_service_responses_bytes_total{code="200",method="GET",protocol="http",service="web@docker"} 50000
traefik_entrypoint_requests_total{code="200",entrypoint="websecure",method="GET",protocol="http"} 99
traefik_service_requests_total{code="200",service="broken@docker"} NaN
`;

describe("traffic metrics", () => {
	test("sums Traefik's service metrics per Homerun slug", () => {
		const bySlug = countersBySlug(
			parseTraefikMetrics(METRICS),
			new Set(["web", "api"]),
		);
		expect([...bySlug.keys()]).toEqual(["web"]);
		expect(bySlug.get("web")).toEqual({
			bytesIn: 1000,
			bytesOut: 50_000,
			durationSeconds: 4.5,
			requests: 100,
			status4xx: 6,
			status5xx: 4,
		});
	});

	test("maps a Traefik service name back to a slug", () => {
		const slugs = new Set(["web", "web-api"]);
		expect(slugForTraefikService("web@swarm", slugs)).toBe("web");
		expect(slugForTraefikService("web-api@docker", slugs)).toBe("web-api");
		expect(slugForTraefikService("web-3000@docker", slugs)).toBe("web");
		expect(slugForTraefikService("api@internal", slugs)).toBeNull();
		expect(slugForTraefikService("other-80@docker", slugs)).toBeNull();
	});

	test("a delta is the increase, and a restart counts from zero", () => {
		const before = {
			bytesIn: 10,
			bytesOut: 100,
			durationSeconds: 1,
			requests: 10,
			status4xx: 1,
			status5xx: 0,
		};
		expect(
			counterDelta(before, { ...before, durationSeconds: 3, requests: 15 }),
		).toEqual({
			bytesIn: 0,
			bytesOut: 0,
			durationSeconds: 2,
			requests: 5,
			status4xx: 0,
			status5xx: 0,
		});
		expect(counterDelta(before, { ...before, requests: 2 }).requests).toBe(2);
	});
});

describe("monitoring ranges", () => {
	const now = new Date("2026-09-28T22:30:00Z");

	test("today starts at local midnight, DST included", () => {
		expect(startOfDay(now, "Europe/Paris").toISOString()).toBe(
			"2026-09-28T22:00:00.000Z",
		);
		expect(startOfDay(now, "America/New_York").toISOString()).toBe(
			"2026-09-28T04:00:00.000Z",
		);
		expect(
			startOfDay(
				new Date("2026-03-29T12:00:00Z"),
				"Europe/Paris",
			).toISOString(),
		).toBe("2026-03-28T23:00:00.000Z");
	});

	test("fixed windows, all time and bucket widths", () => {
		expect(rangeStart("all", now, "UTC")).toBeNull();
		expect(rangeStart("today", now, "UTC")?.toISOString()).toBe(
			"2026-09-28T00:00:00.000Z",
		);
		expect(rangeStart("week", now, "UTC")?.toISOString()).toBe(
			"2026-09-21T22:30:00.000Z",
		);
		expect(bucketSecondsFor(0)).toBe(300);
		expect(bucketSecondsFor(86_400_000)).toBe(1800);
		expect(bucketSecondsFor(365 * 86_400_000) % 300).toBe(0);
		expect(isMonitoringRange("month")).toBe(true);
		expect(isMonitoringRange("decade")).toBe(false);
		expect(isTimeZone("Europe/Paris")).toBe(true);
		expect(isTimeZone("Mars/Olympus")).toBe(false);
	});
});

describe("padBuckets", () => {
	test("fills every bucket of the span, keeping recorded ones", () => {
		const at = (minute: number) => new Date(minute * 60_000);
		const padded = padBuckets(
			[{ at: at(10), value: 3 }],
			{ bucketSeconds: 300, end: at(20), start: at(0) },
			(when) => ({ at: when, value: 0 }),
		);
		expect(padded.map((point) => point.value)).toEqual([0, 0, 3, 0, 0]);
		expect(padded[1]?.at).toEqual(at(5));
	});
});

describe("MonitoringService", () => {
	afterEach(() => restoreStubs());

	test("all time starts at the oldest record and asks every source", async () => {
		const seen: unknown[] = [];
		stub(TrafficSampleDTO, "firstAt", async () => new Date("2026-09-01"));
		stub(StatSampleDTO, "firstAt", async () => new Date("2026-08-01"));
		stub(TrafficSampleDTO, "totals", async (_id: string, since: unknown) => {
			seen.push(since);
			return { requests: 3 };
		});
		stub(
			TrafficSampleDTO,
			"series",
			async (_: string, __: unknown, bucket: number) => {
				seen.push(bucket);
				return [];
			},
		);
		stub(StatSampleDTO, "totals", async () => ({ avgCpuPercent: 1 }));
		stub(StatSampleDTO, "series", async () => []);
		stub(UptimeCheckDTO, "availability", async () => ({}));
		const result = await MonitoringService.forService(
			"s1",
			"all",
			"UTC",
			new Date("2026-09-28"),
		);
		expect(result.since).toBeNull();
		expect(seen[0]).toBeNull();
		expect(result.bucketSeconds).toBe(bucketSecondsFor(58 * 86_400_000));
		expect(result.traffic).toEqual({ requests: 3 } as never);
	});

	test("a service with nothing recorded still gets a range", async () => {
		stub(TrafficSampleDTO, "firstAt", async () => null);
		stub(StatSampleDTO, "firstAt", async () => null);
		for (const [target, key] of [
			[TrafficSampleDTO, "totals"],
			[TrafficSampleDTO, "series"],
			[StatSampleDTO, "totals"],
			[StatSampleDTO, "series"],
			[UptimeCheckDTO, "availability"],
		] as const) {
			stub(target, key, async () => []);
		}
		expect(
			(await MonitoringService.forService("s1", "all", "UTC")).bucketSeconds,
		).toBe(300);
	});
});

describe("StatsSampler traffic", () => {
	let traffic: unknown[][] = [];
	let metrics: string | null = METRICS;

	beforeEach(() => {
		traffic = [];
		metrics = METRICS;
		stub(Logger.prototype, "warn", () => undefined);
		stub(SystemStatsService, "getSystemStats", async () => ({
			cpuPercent: 5,
			diskUsedGb: 1,
			memTotalMb: 1000,
			memUsedMb: 500,
		}));
		stub(CapacityService, "evaluate", async () => {
			throw new Error("thresholds down");
		});
		stub(ServiceDTO, "listRunningWithContainers", async () => [
			{ containerId: "c1", id: "id-web", slug: "web", swarmServiceId: null },
			{ containerId: null, id: "id-api", slug: "api", swarmServiceId: "sw1" },
			{ containerId: null, id: "id-off", slug: "off", swarmServiceId: null },
		]);
		stub(DockerService, "sampleContainerStats", async () => ({
			cpuPercent: 1,
			memLimitMb: 100,
			memUsedMb: 10,
			netRxBytes: 1,
			netTxBytes: 2,
		}));
		stub(DockerService, "listSwarmReplicas", async () => []);
		stub(WorkstationDTO, "listRunning", async () => []);
		stub(DockerService, "traefikMetrics", async () => metrics);
		stub(StatSampleDTO, "recordMany", async () => undefined);
		stub(StatSampleDTO, "prune", async () => undefined);
		stub(TrafficSampleDTO, "prune", async () => undefined);
		stub(TrafficSampleDTO, "recordMany", async (rows: unknown[]) => {
			traffic.push(rows);
		});
	});

	afterEach(() => restoreStubs());

	test("the first read is a baseline, the next records the increase", async () => {
		const sampler = new StatsSampler() as unknown as {
			tick: () => Promise<void>;
		};
		await sampler.tick();
		expect(traffic).toEqual([]);
		metrics = METRICS.replace("} 90\n", "} 120\n");
		await sampler.tick();
		expect(traffic).toEqual([
			[
				{
					bytesIn: 0,
					bytesOut: 0,
					durationSeconds: 0,
					requests: 30,
					serviceId: "id-web",
					status4xx: 0,
					status5xx: 0,
				},
			],
		]);
		metrics = null;
		await sampler.tick();
		expect(traffic).toHaveLength(1);
	});

	test("running workstations are sampled too, an unreadable one skipped", async () => {
		const recorded: unknown[][] = [];
		stub(StatSampleDTO, "recordMany", async (rows: unknown[]) => {
			recorded.push(rows);
		});
		stub(WorkstationDTO, "listRunning", async () => [
			{ id: "ws-up" },
			{ id: "ws-starting" },
		]);
		stub(WorkstationService, "stats", async (ws: { id: string }) => {
			if (ws.id === "ws-starting") {
				throw new Error("not running");
			}
			return {
				cpuPercent: 7,
				memLimitMb: 2048,
				memUsedMb: 300,
				netRxBytes: 5,
				netTxBytes: 6,
			};
		});
		const sampler = new StatsSampler() as unknown as {
			tick: () => Promise<void>;
		};
		await sampler.tick();
		const workstationRows = (recorded[0] as Record<string, unknown>[]).filter(
			(row) => row.workstationId,
		);
		expect(workstationRows).toEqual([
			{
				cpuPercent: 7,
				memLimitMb: 2048,
				memUsedMb: 300,
				netRxBytes: 5,
				netTxBytes: 6,
				serviceId: null,
				workstationId: "ws-up",
			},
		]);
	});

	test("a workstation listing failure doesn't stop the tick", async () => {
		const recorded: unknown[][] = [];
		stub(StatSampleDTO, "recordMany", async (rows: unknown[]) => {
			recorded.push(rows);
		});
		stub(WorkstationDTO, "listRunning", async () => {
			throw new Error("db down");
		});
		const sampler = new StatsSampler() as unknown as {
			tick: () => Promise<void>;
		};
		await sampler.tick();
		expect(recorded).toHaveLength(1);
	});

	test("prunes both histories every sixtieth tick", async () => {
		let pruned = 0;
		stub(TrafficSampleDTO, "prune", async () => {
			pruned += 1;
		});
		const sampler = new StatsSampler() as unknown as {
			tick: () => Promise<void>;
		};
		for (let i = 0; i < 60; i += 1) {
			// oxlint-disable-next-line no-await-in-loop -- ticks run one after another
			await sampler.tick();
		}
		expect(pruned).toBe(1);
	});
});

describe("scoped monitoring", () => {
	afterEach(() => restoreStubs());

	test("a scope asks each source for its own services, the host for resources", async () => {
		const asked: unknown[] = [];
		const record =
			(name: string) =>
			async (...args: unknown[]) => {
				asked.push([name, args[0]]);
				return name.endsWith("series") ? [] : {};
			};
		stub(TrafficSampleDTO, "totals", record("traffic.totals"));
		stub(TrafficSampleDTO, "series", record("traffic.series"));
		stub(StatSampleDTO, "totals", record("stat.totals"));
		stub(StatSampleDTO, "series", record("stat.series"));
		stub(UptimeCheckDTO, "availability", record("uptime"));
		await MonitoringService.forScope(
			{ resources: "host", serviceIds: ["a", "b"] },
			"week",
			"UTC",
		);
		expect(asked).toEqual([
			["traffic.totals", ["a", "b"]],
			["traffic.series", ["a", "b"]],
			["stat.totals", "host"],
			["stat.series", "host"],
			["uptime", ["a", "b"]],
			["traffic.totals", ["a", "b"]],
			["stat.totals", "host"],
			["uptime", ["a", "b"]],
		]);
	});

	test("the breakdown lists every service, busiest first, idle ones with zeros", async () => {
		stub(
			TrafficSampleDTO,
			"totalsByService",
			async () =>
				new Map([
					[
						"b",
						{
							avgResponseMs: 5,
							bytesIn: 0,
							bytesOut: 10,
							requests: 40,
							status4xx: 1,
							status5xx: 0,
						},
					],
					[
						"c",
						{
							avgResponseMs: 9,
							bytesIn: 0,
							bytesOut: 1,
							requests: 2,
							status4xx: 0,
							status5xx: 0,
						},
					],
				]),
		);
		stub(
			StatSampleDTO,
			"averagesByService",
			async () =>
				new Map([
					["a", { avgCpuPercent: 3, avgMemUsedMb: 20 }],
					["d", { avgCpuPercent: 9, avgMemUsedMb: 20 }],
				]),
		);
		const rows = await MonitoringService.breakdown(["a", "b", "c", "d"], null);
		expect(rows.map((row) => row.serviceId)).toEqual(["b", "c", "d", "a"]);
		expect(rows[3]).toMatchObject({ avgCpuPercent: 3, requests: 0 });
		expect(rows[1]?.avgCpuPercent).toBeNull();
	});
});

describe("monitoring formatting and requests", () => {
	test("formats counts, durations, shares and sizes", async () => {
		const { formatCount, formatMb, formatMs, formatPercent } = await import(
			"../../../src/lib/metrics-format"
		);
		expect(formatCount(1234)).toBe((1234).toLocaleString());
		expect(formatCount(25_000)).not.toContain("25,000");
		expect(formatMs(null)).toBe("—");
		expect(formatMs(42.4)).toBe("42 ms");
		expect(formatMs(1500)).toBe("1.50 s");
		expect(formatPercent(1, 4)).toBe("25.0%");
		expect(formatPercent(1, 0)).toBe("—");
		expect(formatMb(null)).toBe("—");
		expect(formatMb(512)).toBe("512 MB");
		expect(formatMb(2048)).toBe("2.00 GB");
	});

	test("reads the range and time zone, falling back to a week in UTC", async () => {
		const { monitoringRequest } = await import(
			"../../../src/lib/server/monitoring-request"
		);
		const cookies = (tz?: string) => ({ get: () => tz });
		expect(
			monitoringRequest(
				new URL("http://x/?range=today"),
				cookies("Europe/Paris"),
			),
		).toEqual({ range: "today", zone: "Europe/Paris" });
		expect(
			monitoringRequest(
				new URL("http://x/?range=decade"),
				cookies("Mars/Base"),
			),
		).toEqual({ range: "week", zone: "UTC" });
	});
});

describe("period comparison", () => {
	test("formats relative and point changes with a good or bad direction", async () => {
		const { formatChange } = await import("../../../src/lib/metrics-format");
		expect(formatChange(120, 100, { higherIsBetter: false })).toEqual({
			direction: "worse",
			text: "+20.0%",
		});
		expect(formatChange(80, 100, { higherIsBetter: false })).toEqual({
			direction: "better",
			text: "−20.0%",
		});
		expect(formatChange(150, 100, { higherIsBetter: null })?.direction).toBe(
			"same",
		);
		expect(
			formatChange(99.9, 99.5, { higherIsBetter: true, points: true }),
		).toEqual({ direction: "better", text: "+0.40 pts" });
		expect(formatChange(5, 5, { higherIsBetter: true })).toEqual({
			direction: "same",
			text: "±0.0%",
		});
		expect(formatChange(5, 0, { higherIsBetter: true })).toBeNull();
		expect(formatChange(null, 3, { higherIsBetter: true })).toBeNull();
	});

	test("the previous window is yesterday so far, or the span right before", async () => {
		const { previousWindow } = await import(
			"../../../src/lib/monitoring-ranges"
		);
		const now = new Date("2026-09-29T15:00:00Z");
		expect(previousWindow("all", null, now)).toBeNull();
		expect(
			previousWindow("today", new Date("2026-09-29T00:00:00Z"), now),
		).toMatchObject({
			end: new Date("2026-09-28T15:00:00Z"),
			start: new Date("2026-09-28T00:00:00Z"),
		});
		expect(
			previousWindow("week", new Date("2026-09-22T15:00:00Z"), now),
		).toMatchObject({
			end: new Date("2026-09-22T15:00:00Z"),
			start: new Date("2026-09-15T15:00:00Z"),
		});
	});

	test("each metric compares in its own terms", async () => {
		const { monitoringChanges } = await import(
			"../../../src/lib/monitoring-changes"
		);
		const totals = (requests: number, ok: number, cpu: number) => ({
			availability: {
				external: { avgLatencyMs: 10, checks: 100, ok },
				internal: { avgLatencyMs: 1, checks: 0, ok: 0 },
			},
			resources: {
				avgCpuPercent: cpu,
				avgMemUsedMb: 100,
				memLimitMb: null,
				peakCpuPercent: cpu,
				peakMemUsedMb: 100,
			},
			traffic: {
				avgResponseMs: 50,
				bytesIn: 0,
				bytesOut: 10,
				requests,
				status4xx: requests / 10,
				status5xx: 0,
			},
		});
		const changes = monitoringChanges({
			...totals(200, 100, 10),
			previous: { ...totals(100, 98, 20), label: "vs the 7 days before" },
		} as never);
		expect(changes.requests).toEqual({ direction: "same", text: "+100.0%" });
		expect(changes.uptimePublic).toEqual({
			direction: "better",
			text: "+2.00 pts",
		});
		expect(changes.avgCpu).toEqual({ direction: "better", text: "−50.0%" });
		expect(changes.errorRate?.direction).toBe("same");
		expect(changes.uptimeNetwork).toBeNull();
		expect(monitoringChanges({ previous: null } as never)).toEqual({});
	});
});
