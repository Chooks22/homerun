import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { TraceSpanDTO } = await import("../../../src/lib/dto/trace-span-dto");
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { otlpIngestToken, pipelineSpanToken } = await import(
	"../../../src/lib/tracing/ingest-token"
);
const { TracingService, MAX_OTLP_BODY_BYTES } = await import(
	"../../../src/lib/services/tracing.service"
);

const TRACE = "5b8efff798038103d269b633813fc60c";

function body(attributes: Record<string, unknown>) {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: Object.entries(attributes).map(([key, value]) => ({
						key,
						value:
							typeof value === "boolean"
								? { boolValue: value }
								: { stringValue: String(value) },
					})),
				},
				scopeSpans: [
					{
						spans: [
							{
								endTimeUnixNano: "1700000001000000000",
								name: "GET /",
								spanId: "eee19b7ec3c1b174",
								startTimeUnixNano: "1700000000000000000",
								traceId: TRACE,
							},
						],
					},
				],
			},
		],
	};
}

function request(
	payload: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request("http://app/api/v1/otlp/v1/traces", {
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
		headers: {
			authorization: `Bearer ${otlpIngestToken(config.auth.secret)}`,
			"content-type": "application/json",
			...headers,
		},
		method: "POST",
	});
}

let collectorEnabled = true;
let inserted: Record<string, unknown>[] = [];
let persisted: unknown[] = [];
let reconciled: unknown[] = [];
let fetched: string[] = [];

beforeEach(() => {
	collectorEnabled = true;
	inserted = [];
	persisted = [];
	reconciled = [];
	fetched = [];
	TracingService.forgetServices();
	stub(InstanceSettingsDTO, "get", async () => ({
		persistTracing: async (input: unknown) => {
			persisted.push(input);
		},
		toJSON: () => ({
			otelCollectorEnabled: collectorEnabled,
			traceRetentionDays: 3,
		}),
	}));
	stub(ServiceDTO, "list", async () => [
		{ toJSON: () => ({ id: "svc-1", slug: "api", tracesEnabled: true }) },
		{ toJSON: () => ({ id: "svc-2", slug: "web", tracesEnabled: false }) },
	]);
	stub(TraceSpanDTO, "insertMany", async (rows: Record<string, unknown>[]) => {
		inserted.push(...rows);
		return rows.length;
	});
	stub(DockerService, "reconcileOtel", async (state: unknown) => {
		reconciled.push(state);
	});
	stub(DockerService, "otelRunning", async () => true);
	stub(globalThis, "fetch", async (input: string) => {
		fetched.push(input);
		return new Response("{}", { status: 200 });
	});
});

afterEach(restoreStubs);

describe("TracingService.ingest", () => {
	test("stores a traced service's spans and drops the rest", async () => {
		const response = await TracingService.ingest(
			request({
				resourceSpans: [
					...body({ "service.name": "api" }).resourceSpans,
					...body({ "service.name": "web" }).resourceSpans,
				],
			}),
		);
		expect(response.status).toBe(200);
		expect(inserted.map((row) => row.serviceId)).toEqual(["svc-1"]);
	});

	test("reads a gzipped body", async () => {
		const response = await TracingService.ingest(
			new Request("http://app/api/v1/otlp/v1/traces", {
				body: gzipSync(JSON.stringify(body({ "service.name": "api" }))),
				headers: {
					authorization: `Bearer ${otlpIngestToken(config.auth.secret)}`,
					"content-encoding": "gzip",
					"content-type": "application/json",
				},
				method: "POST",
			}),
		);
		expect(response.status).toBe(200);
		expect(inserted).toHaveLength(1);
	});

	test("refuses a bad token, a non-JSON body, an oversized body and junk", async () => {
		expect(
			(
				await TracingService.ingest(
					request(body({}), { authorization: "Bearer nope" }),
				)
			).status,
		).toBe(401);
		expect(
			(
				await TracingService.ingest(
					request(body({}), { "content-type": "application/x-protobuf" }),
				)
			).status,
		).toBe(415);
		expect(
			(
				await TracingService.ingest(
					request("a".repeat(MAX_OTLP_BODY_BYTES + 1)),
				)
			).status,
		).toBe(413);
		const junk = await TracingService.ingest(request("{not json"));
		expect(junk.status).toBe(400);
		const shape = await TracingService.ingest(request({ nope: true }));
		expect(shape.status).toBe(400);
		expect(await shape.json()).toEqual({
			message: "Expected an OTLP/JSON body with resourceSpans",
		});
		expect(inserted).toEqual([]);
	});
});

describe("TracingService.exportSpans", () => {
	const ci = body({
		"homerun.pipeline": pipelineSpanToken(config.auth.secret, "svc-2"),
		"homerun.service.id": "svc-2",
		"service.name": "github-actions",
	});

	test("stores CI spans of a service with traces off without the token, and drops forged ones", async () => {
		collectorEnabled = false;
		await TracingService.exportSpans(ci as never);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.resourceAttributes).toEqual({
			"homerun.service.id": "svc-2",
			"service.name": "github-actions",
		});
		const forged = body({
			"homerun.pipeline": true,
			"homerun.service.id": "svc-2",
			"service.name": "github-actions",
		});
		await TracingService.exportSpans(forged as never);
		const response = await TracingService.ingest(request(forged));
		expect(response.status).toBe(200);
		expect(inserted).toHaveLength(1);
	});

	test("hands spans to the collector when it's on", async () => {
		expect(await TracingService.exportSpans(ci as never)).toBe(true);
		expect(fetched).toEqual(["http://homerun-otel:4318/v1/traces"]);
		expect(inserted).toEqual([]);
	});

	test("stores them directly when the collector refuses or is unreachable", async () => {
		stub(globalThis, "fetch", async () => new Response("", { status: 503 }));
		expect(await TracingService.exportSpans(ci as never)).toBe(false);
		stub(globalThis, "fetch", async () => {
			throw new Error("getaddrinfo ENOTFOUND homerun-otel");
		});
		expect(await TracingService.exportSpans(ci as never)).toBe(false);
		expect(inserted.map((row) => [row.serviceId, row.serviceName])).toEqual([
			["svc-2", "github-actions"],
			["svc-2", "github-actions"],
		]);
	});

	test("skips the collector entirely when it's off", async () => {
		collectorEnabled = false;
		expect(await TracingService.exportSpans(ci as never)).toBe(false);
		expect(fetched).toEqual([]);
		expect(inserted).toHaveLength(1);
	});
});

describe("collector settings", () => {
	test("reports the toggle, the retention and whether it runs", async () => {
		expect(await TracingService.collectorStatus()).toMatchObject({
			enabled: true,
			retentionDays: 3,
			running: true,
		});
	});

	test("saves, then starts or removes the collector to match", async () => {
		await TracingService.saveSettings({
			collectorEnabled: false,
			retentionDays: 14,
		});
		expect(persisted).toEqual([
			{ otelCollectorEnabled: false, traceRetentionDays: 14 },
		]);
		expect(reconciled).toEqual([null]);
		await expect(
			TracingService.saveSettings({ collectorEnabled: true, retentionDays: 0 }),
		).rejects.toThrow("Keep traces between");
	});

	test("brings the collector back only when it's on", async () => {
		await TracingService.reassertCollector();
		expect(reconciled).toHaveLength(1);
		collectorEnabled = false;
		await TracingService.reassertCollector();
		expect(reconciled).toHaveLength(1);
	});

	test("prunes spans past the retention", async () => {
		const cutoffs: Date[] = [];
		stub(TraceSpanDTO, "pruneBefore", async (cutoff: Date) => {
			cutoffs.push(cutoff);
			return 2;
		});
		await TracingService.prune(new Date("2026-10-10T00:00:00Z"));
		expect(cutoffs).toEqual([new Date("2026-10-07T00:00:00Z")]);
	});
});
