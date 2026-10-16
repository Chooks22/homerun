import { describe, expect, test } from "bun:test";
import { withTracingEnv } from "../../../src/lib/tracing/env";
import {
	otlpIngestToken,
	pipelineSpanToken,
	validOtlpAuthorization,
	validPipelineSpanToken,
} from "../../../src/lib/tracing/ingest-token";
import {
	normalizeTraceId,
	TRACE_SORT_KEYS,
} from "../../../src/lib/tracing/list";
import {
	flattenAnyValue,
	flattenAttributes,
	isOtlpPath,
	MAX_SPANS_PER_REQUEST,
	nanosOf,
	OtlpError,
	parseOtlpTraces,
	parseSpan,
	spanOwner,
} from "../../../src/lib/tracing/otlp";
import {
	parseRetentionDays,
	retentionCutoff,
	tracingSettings,
} from "../../../src/lib/tracing/settings";
import {
	buildWaterfall,
	formatSpanDuration,
	kindLabel,
	statusLabel,
} from "../../../src/lib/tracing/waterfall";

const TRACE = "5b8efff798038103d269b633813fc60c";
const ROOT = "eee19b7ec3c1b174";
const CHILD = "eee19b7ec3c1b173";

function otlpSpan(overrides: Record<string, unknown> = {}) {
	return {
		attributes: [{ key: "http.method", value: { stringValue: "GET" } }],
		endTimeUnixNano: "1544712661000000000",
		kind: 2,
		name: "GET /",
		spanId: ROOT,
		startTimeUnixNano: "1544712660000000000",
		status: {},
		traceId: TRACE,
		...overrides,
	};
}

describe("flattenAnyValue", () => {
	test("unwraps every OTLP value kind into plain JSON", () => {
		expect(flattenAnyValue({ stringValue: "a" })).toBe("a");
		expect(flattenAnyValue({ boolValue: true })).toBe(true);
		expect(flattenAnyValue({ intValue: "42" })).toBe(42);
		expect(flattenAnyValue({ intValue: 7 })).toBe(7);
		expect(flattenAnyValue({ intValue: "9223372036854775807" })).toBe(
			"9223372036854775807",
		);
		expect(flattenAnyValue({ doubleValue: 1.5 })).toBe(1.5);
		expect(flattenAnyValue({ bytesValue: "aGk=" })).toBe("aGk=");
		expect(
			flattenAnyValue({
				arrayValue: { values: [{ stringValue: "x" }, { intValue: "1" }] },
			}),
		).toEqual(["x", 1]);
		expect(
			flattenAnyValue({
				kvlistValue: { values: [{ key: "k", value: { boolValue: false } }] },
			}),
		).toEqual({ k: false });
	});

	test("turns anything unknown, empty or too deep into null", () => {
		expect(flattenAnyValue(null)).toBeNull();
		expect(flattenAnyValue("raw")).toBeNull();
		expect(flattenAnyValue({})).toBeNull();
		expect(flattenAnyValue({ arrayValue: null })).toEqual([]);
		expect(flattenAnyValue({ kvlistValue: null })).toEqual({});
		expect(flattenAnyValue({ stringValue: "deep" }, 5)).toBeNull();
	});

	test("caps long strings", () => {
		const long = "x".repeat(10_000);
		expect(String(flattenAnyValue({ stringValue: long })).length).toBe(4096);
	});
});

describe("flattenAttributes", () => {
	test("keeps keyed entries and skips malformed ones", () => {
		expect(
			flattenAttributes([
				{ key: "a", value: { stringValue: "1" } },
				{ value: { stringValue: "no key" } },
				"junk",
				{ key: "", value: { stringValue: "empty key" } },
			]),
		).toEqual({ a: "1" });
		expect(flattenAttributes(undefined)).toEqual({});
	});

	test("keeps at most 128 keys", () => {
		const many = Array.from({ length: 200 }, (_, index) => ({
			key: `k${index}`,
			value: { intValue: index },
		}));
		expect(Object.keys(flattenAttributes(many))).toHaveLength(128);
	});
});

describe("nanosOf", () => {
	test("reads strings and numbers, refuses the rest", () => {
		expect(nanosOf("1544712660000000000")).toBe(1544712660000000000n);
		expect(nanosOf(1000)).toBe(1000n);
		expect(nanosOf("soon")).toBeNull();
		expect(nanosOf("0")).toBeNull();
		expect(nanosOf(null)).toBeNull();
		expect(nanosOf(1.5)).toBeNull();
	});
});

describe("parseSpan", () => {
	test("maps a full span", () => {
		const span = parseSpan(
			otlpSpan({
				events: [
					{
						attributes: [
							{ key: "exception.message", value: { stringValue: "boom" } },
						],
						name: "exception",
						timeUnixNano: "1544712660500000000",
					},
					"junk",
				],
				parentSpanId: CHILD.toUpperCase(),
				status: { code: 2, message: "failed" },
			}),
		);
		expect(span).toEqual({
			attributes: { "http.method": "GET" },
			durationMs: 1000,
			endTime: new Date(1544712661000),
			events: [
				{
					attributes: { "exception.message": "boom" },
					name: "exception",
					time: new Date(1544712660500).toISOString(),
				},
			],
			kind: 2,
			name: "GET /",
			parentSpanId: CHILD,
			spanId: ROOT,
			startTime: new Date(1544712660000),
			statusCode: 2,
			statusMessage: "failed",
			traceId: TRACE,
		});
	});

	test("reads enum names, sub-millisecond durations and missing parents", () => {
		const span = parseSpan(
			otlpSpan({
				endTimeUnixNano: "1544712660000250000",
				kind: "SPAN_KIND_CLIENT",
				parentSpanId: "",
				status: { code: "STATUS_CODE_OK" },
			}),
		);
		expect(span?.kind).toBe(3);
		expect(span?.statusCode).toBe(1);
		expect(span?.parentSpanId).toBeNull();
		expect(span?.durationMs).toBe(0.25);
		expect(span?.statusMessage).toBeNull();
	});

	test("clamps an end before the start and unknown enums", () => {
		const span = parseSpan(
			otlpSpan({
				endTimeUnixNano: "1",
				events: [{ name: "no time" }],
				kind: 42,
				status: null,
			}),
		);
		expect(span?.durationMs).toBe(0);
		expect(span?.kind).toBe(0);
		expect(span?.statusCode).toBe(0);
		expect(span?.events[0]?.time).toBe("");
	});

	test("refuses a span without valid ids or start", () => {
		expect(parseSpan(null)).toBeNull();
		expect(parseSpan(otlpSpan({ traceId: "nothex" }))).toBeNull();
		expect(parseSpan(otlpSpan({ traceId: "0".repeat(32) }))).toBeNull();
		expect(parseSpan(otlpSpan({ spanId: 12 }))).toBeNull();
		expect(parseSpan(otlpSpan({ startTimeUnixNano: undefined }))).toBeNull();
	});
});

describe("parseOtlpTraces", () => {
	test("groups valid spans under their resource across scopes", () => {
		const resources = parseOtlpTraces({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "api" } },
						],
					},
					scopeSpans: [
						{ spans: [otlpSpan()] },
						{ spans: [otlpSpan({ spanId: CHILD }), { traceId: "bad" }] },
						"junk",
					],
				},
				"junk",
				{ scopeSpans: [{ spans: [] }] },
			],
		});
		expect(resources).toHaveLength(2);
		expect(resources[0]?.attributes).toEqual({ "service.name": "api" });
		expect(resources[0]?.spans.map((span) => span.spanId)).toEqual([
			ROOT,
			CHILD,
		]);
		expect(resources[1]).toEqual({ attributes: {}, spans: [] });
	});

	test("stops at the per-request span budget", () => {
		const spans = Array.from({ length: MAX_SPANS_PER_REQUEST + 5 }, (_, i) =>
			otlpSpan({ spanId: (i + 1).toString(16).padStart(16, "0") }),
		);
		const [resource] = parseOtlpTraces({
			resourceSpans: [{ scopeSpans: [{ spans }] }, { scopeSpans: [{ spans }] }],
		});
		expect(resource?.spans).toHaveLength(MAX_SPANS_PER_REQUEST);
	});

	test("refuses a body that isn't an export request", () => {
		expect(() => parseOtlpTraces([])).toThrow(OtlpError);
		expect(() => parseOtlpTraces({ resourceSpans: {} })).toThrow(OtlpError);
	});
});

describe("spanOwner", () => {
	const services = [
		{ id: "svc-api", slug: "api", tracesEnabled: true },
		{ id: "svc-web", slug: "web", tracesEnabled: false },
	];

	test("maps by homerun.service.id first, then by slug", () => {
		expect(
			spanOwner(
				{ "homerun.service.id": "svc-api", "service.name": "custom" },
				services,
			),
		).toEqual({ serviceId: "svc-api", serviceName: "custom" });
		expect(spanOwner({ "homerun.service.id": "svc-api" }, services)).toEqual({
			serviceId: "svc-api",
			serviceName: "api",
		});
		expect(spanOwner({ "service.name": "api" }, services)).toEqual({
			serviceId: "svc-api",
			serviceName: "api",
		});
		expect(
			spanOwner(
				{ "homerun.service.id": "gone", "service.name": "api" },
				services,
			),
		).toEqual({ serviceId: "svc-api", serviceName: "api" });
	});

	test("drops a service with traces off and anything unknown", () => {
		expect(spanOwner({ "service.name": "web" }, services)).toBeNull();
		expect(spanOwner({ "service.name": "stranger" }, services)).toBeNull();
		expect(spanOwner({}, services)).toBeNull();
	});

	test("keeps a service's CI spans with its traces off only on a valid token", () => {
		const isPipeline = (id: string, value: unknown) =>
			validPipelineSpanToken(value, "secret", id);
		const token = pipelineSpanToken("secret", "svc-web");
		expect(
			spanOwner(
				{
					"homerun.pipeline": token,
					"homerun.service.id": "svc-web",
					"service.name": "github-actions",
				},
				services,
				isPipeline,
			),
		).toEqual({ serviceId: "svc-web", serviceName: "github-actions" });
		for (const forged of [
			true,
			"true",
			pipelineSpanToken("secret", "svc-api"),
			pipelineSpanToken("other-secret", "svc-web"),
		]) {
			expect(
				spanOwner(
					{ "homerun.pipeline": forged, "homerun.service.id": "svc-web" },
					services,
					isPipeline,
				),
			).toBeNull();
		}
		expect(
			spanOwner(
				{ "homerun.pipeline": token, "homerun.service.id": "svc-web" },
				services,
			),
		).toBeNull();
	});

	test("keeps Homerun's own spans with no service", () => {
		expect(spanOwner({ "service.name": "homerun-worker" }, services)).toEqual({
			serviceId: null,
			serviceName: "homerun-worker",
		});
	});
});

describe("isOtlpPath", () => {
	test("matches only the traces ingest", () => {
		expect(isOtlpPath("/api/v1/otlp/v1/traces")).toBe(true);
		expect(isOtlpPath("/api/v1/otlp/v1/metrics")).toBe(false);
		expect(isOtlpPath("/api/v1/services")).toBe(false);
	});
});

describe("ingest token", () => {
	test("is derived from the secret and checked in constant time", () => {
		const token = otlpIngestToken("secret");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(token).not.toBe(otlpIngestToken("other"));
		expect(validOtlpAuthorization(`Bearer ${token}`, "secret")).toBe(true);
		expect(validOtlpAuthorization(` Bearer ${token} `, "secret")).toBe(true);
		expect(validOtlpAuthorization(`Bearer ${token}`, "other")).toBe(false);
		expect(validOtlpAuthorization("Bearer nope", "secret")).toBe(false);
		expect(validOtlpAuthorization(null, "secret")).toBe(false);
	});
});

describe("withTracingEnv", () => {
	const service = { id: "svc-1", slug: "api" };

	test("injects the SDK variables pointing at the collector", () => {
		expect(withTracingEnv({ PORT: "3000" }, service)).toEqual({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://homerun-otel:4318",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
			OTEL_RESOURCE_ATTRIBUTES: "homerun.service.id=svc-1",
			OTEL_SERVICE_NAME: "api",
			OTEL_TRACES_EXPORTER: "otlp",
			PORT: "3000",
		});
	});

	test("never overrides a variable the service sets", () => {
		const env = withTracingEnv(
			{
				OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
				OTEL_SERVICE_NAME: "mine",
			},
			service,
		);
		expect(env.OTEL_SERVICE_NAME).toBe("mine");
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
	});

	test("merges the service id into the service's own resource attributes", () => {
		expect(
			withTracingEnv({ OTEL_RESOURCE_ATTRIBUTES: "team=core" }, service)
				.OTEL_RESOURCE_ATTRIBUTES,
		).toBe("homerun.service.id=svc-1,team=core");
		expect(
			withTracingEnv(
				{ OTEL_RESOURCE_ATTRIBUTES: "homerun.service.id=pinned,team=core" },
				service,
			).OTEL_RESOURCE_ATTRIBUTES,
		).toBe("homerun.service.id=pinned,team=core");
	});
});

describe("retention settings", () => {
	test("accepts whole days in range only", () => {
		expect(parseRetentionDays("7")).toBe(7);
		expect(parseRetentionDays(" 90 ")).toBe(90);
		expect(parseRetentionDays("0")).toBeNull();
		expect(parseRetentionDays("91")).toBeNull();
		expect(parseRetentionDays("1.5")).toBeNull();
		expect(parseRetentionDays(null)).toBeNull();
	});

	test("fills in the defaults", () => {
		expect(
			tracingSettings({ otelCollectorEnabled: null, traceRetentionDays: null }),
		).toEqual({ collectorEnabled: true, retentionDays: 7 });
		expect(
			tracingSettings({ otelCollectorEnabled: true, traceRetentionDays: 30 }),
		).toEqual({ collectorEnabled: true, retentionDays: 30 });
	});

	test("cuts off at whole days before now", () => {
		expect(
			retentionCutoff(7, new Date("2026-10-08T12:00:00Z")).toISOString(),
		).toBe("2026-10-01T12:00:00.000Z");
	});
});

describe("trace ids and sorts", () => {
	test("normalizes a trace id or refuses it", () => {
		expect(normalizeTraceId(` ${TRACE.toUpperCase()} `)).toBe(TRACE);
		expect(normalizeTraceId("abc")).toBeNull();
		expect(normalizeTraceId(42)).toBeNull();
		expect(TRACE_SORT_KEYS).toEqual(["started", "duration", "spans"]);
	});
});

describe("buildWaterfall", () => {
	const at = (ms: number) => new Date(1_000_000 + ms);

	test("nests children under parents in start order, positioned by time", () => {
		const { rows, startMs, totalMs } = buildWaterfall([
			{ durationMs: 40, parentSpanId: "root", spanId: "b", startTime: at(50) },
			{ durationMs: 100, parentSpanId: null, spanId: "root", startTime: at(0) },
			{ durationMs: 20, parentSpanId: "root", spanId: "a", startTime: at(10) },
			{ durationMs: 5, parentSpanId: "a", spanId: "a1", startTime: at(15) },
		]);
		expect(startMs).toBe(1_000_000);
		expect(totalMs).toBe(100);
		expect(rows.map((row) => [row.span.spanId, row.depth])).toEqual([
			["root", 0],
			["a", 1],
			["a1", 2],
			["b", 1],
		]);
		expect(rows[3]?.offsetPercent).toBe(50);
		expect(rows[3]?.widthPercent).toBe(40);
	});

	test("treats a span whose parent never arrived as a root, and survives cycles", () => {
		const { rows } = buildWaterfall([
			{
				durationMs: 0,
				parentSpanId: "missing",
				spanId: "orphan",
				startTime: at(0).toISOString(),
			},
			{ durationMs: 1, parentSpanId: "y", spanId: "x", startTime: at(0) },
			{ durationMs: 1, parentSpanId: "x", spanId: "y", startTime: at(0) },
		]);
		expect(rows.map((row) => row.span.spanId)).toEqual(["orphan"]);
		expect(rows[0]?.widthPercent).toBe(0);
	});

	test("is empty for no spans", () => {
		expect(buildWaterfall([])).toEqual({ rows: [], startMs: 0, totalMs: 0 });
	});
});

describe("labels", () => {
	test("formats durations at a useful precision", () => {
		expect(formatSpanDuration(0.85)).toBe("850 µs");
		expect(formatSpanDuration(12.44)).toBe("12.4 ms");
		expect(formatSpanDuration(250.4)).toBe("250 ms");
		expect(formatSpanDuration(1240)).toBe("1.24 s");
		expect(formatSpanDuration(125_000)).toBe("2 min 5 s");
	});

	test("names statuses and kinds", () => {
		expect(statusLabel(2)).toBe("error");
		expect(statusLabel(1)).toBe("ok");
		expect(statusLabel(0)).toBe("unset");
		expect(kindLabel(2)).toBe("server");
		expect(kindLabel(9)).toBe("unspecified");
	});
});
