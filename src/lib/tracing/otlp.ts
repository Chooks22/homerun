export const OTLP_TRACES_PATH = "/api/v1/otlp/v1/traces";

export const SERVICE_ID_ATTRIBUTE = "homerun.service.id";

export const PIPELINE_ATTRIBUTE = "homerun.pipeline";

export const HOMERUN_SERVICE_NAMES = new Set(["homerun", "homerun-worker"]);

export const MAX_SPANS_PER_REQUEST = 10_000;

const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 128;
const MAX_STRING = 4096;
const MAX_NAME = 512;
const MAX_DEPTH = 4;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_ID_RE = /^0+$/;

const SPAN_KINDS: Record<string, number> = {
	SPAN_KIND_CLIENT: 3,
	SPAN_KIND_CONSUMER: 5,
	SPAN_KIND_INTERNAL: 1,
	SPAN_KIND_PRODUCER: 4,
	SPAN_KIND_SERVER: 2,
	SPAN_KIND_UNSPECIFIED: 0,
};

const STATUS_CODES: Record<string, number> = {
	STATUS_CODE_ERROR: 2,
	STATUS_CODE_OK: 1,
	STATUS_CODE_UNSET: 0,
};

export interface SpanEvent {
	attributes: Record<string, unknown>;
	name: string;
	time: string;
}

export interface ParsedSpan {
	attributes: Record<string, unknown>;
	durationMs: number;
	endTime: Date;
	events: SpanEvent[];
	kind: number;
	name: string;
	parentSpanId: string | null;
	spanId: string;
	startTime: Date;
	statusCode: number;
	statusMessage: string | null;
	traceId: string;
}

export interface ParsedResource {
	attributes: Record<string, unknown>;
	spans: ParsedSpan[];
}

export interface TracedService {
	id: string;
	slug: string;
	tracesEnabled: boolean;
}

export interface SpanOwner {
	serviceId: string | null;
	serviceName: string;
}

export class OtlpError extends Error {}

/** Whether a request path is the internal OTLP ingest, which skips the session, API key and CSRF layers for its own bearer token. */
export function isOtlpPath(pathname: string): boolean {
	return pathname === OTLP_TRACES_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function capped(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function integerOf(value: unknown): number | string {
	if (typeof value === "number") {
		return value;
	}
	const text = String(value);
	const parsed = Number(text);
	return Number.isSafeInteger(parsed) ? parsed : text;
}

/**
 * Flattens an OTLP `AnyValue` (`{stringValue}`, `{intValue}`, `{arrayValue}`,
 * …) into the plain JSON value it carries. A 64-bit integer past what a
 * JavaScript number holds exactly stays a string; nesting deeper than a few
 * levels is cut off.
 */
export function flattenAnyValue(value: unknown, depth = 0): unknown {
	if (!isRecord(value) || depth > MAX_DEPTH) {
		return null;
	}
	if ("stringValue" in value) {
		return capped(String(value.stringValue), MAX_STRING);
	}
	if ("boolValue" in value) {
		return value.boolValue === true;
	}
	if ("intValue" in value) {
		return integerOf(value.intValue);
	}
	if ("doubleValue" in value) {
		return Number(value.doubleValue);
	}
	if ("bytesValue" in value) {
		return capped(String(value.bytesValue), MAX_STRING);
	}
	if ("arrayValue" in value) {
		const array = isRecord(value.arrayValue) ? value.arrayValue.values : [];
		return listOf(array)
			.slice(0, MAX_ATTRIBUTES)
			.map((item) => flattenAnyValue(item, depth + 1));
	}
	if ("kvlistValue" in value) {
		const list = isRecord(value.kvlistValue) ? value.kvlistValue.values : [];
		return flattenAttributes(list, depth + 1);
	}
	return null;
}

/** Flattens a list of OTLP `KeyValue`s into a plain object, keeping the first 128 keys. */
export function flattenAttributes(
	list: unknown,
	depth = 0,
): Record<string, unknown> {
	const flat: Record<string, unknown> = {};
	for (const entry of listOf(list).slice(0, MAX_ATTRIBUTES)) {
		if (isRecord(entry) && typeof entry.key === "string" && entry.key) {
			flat[capped(entry.key, MAX_NAME)] = flattenAnyValue(entry.value, depth);
		}
	}
	return flat;
}

/**
 * Nanoseconds since the epoch, as OTLP/JSON sends them (a decimal string, or
 * a number), or null when it isn't one.
 */
export function nanosOf(value: unknown): bigint | null {
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}
	try {
		const nanos = BigInt(value);
		return nanos > 0n ? nanos : null;
	} catch {
		return null;
	}
}

function dateOf(nanos: bigint): Date {
	return new Date(Number(nanos / 1_000_000n));
}

function enumOf(
	value: unknown,
	names: Record<string, number>,
	max: number,
): number {
	if (typeof value === "string" && value in names) {
		return names[value] ?? 0;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : 0;
}

function idOf(value: unknown, pattern: RegExp): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const id = value.toLowerCase();
	return pattern.test(id) && !ZERO_ID_RE.test(id) ? id : null;
}

function eventOf(value: unknown): SpanEvent | null {
	if (!isRecord(value)) {
		return null;
	}
	const nanos = nanosOf(value.timeUnixNano);
	return {
		attributes: flattenAttributes(value.attributes),
		name: capped(String(value.name ?? ""), MAX_NAME),
		time: nanos ? dateOf(nanos).toISOString() : "",
	};
}

/**
 * One OTLP/JSON span as a row-ready span, or null when it lacks a valid trace
 * id, span id or start time. A missing or earlier end time is taken as the
 * start, so the duration is never negative.
 */
export function parseSpan(value: unknown): ParsedSpan | null {
	if (!isRecord(value)) {
		return null;
	}
	const traceId = idOf(value.traceId, TRACE_ID_RE);
	const spanId = idOf(value.spanId, SPAN_ID_RE);
	const start = nanosOf(value.startTimeUnixNano);
	if (!(traceId && spanId && start)) {
		return null;
	}
	const declaredEnd = nanosOf(value.endTimeUnixNano);
	const end = declaredEnd && declaredEnd > start ? declaredEnd : start;
	const status = isRecord(value.status) ? value.status : {};
	const message =
		typeof status.message === "string" && status.message
			? capped(status.message, MAX_STRING)
			: null;
	return {
		attributes: flattenAttributes(value.attributes),
		durationMs: Number(end - start) / 1_000_000,
		endTime: dateOf(end),
		events: listOf(value.events)
			.slice(0, MAX_EVENTS)
			.map(eventOf)
			.filter((event): event is SpanEvent => event !== null),
		kind: enumOf(value.kind, SPAN_KINDS, 5),
		name: capped(String(value.name ?? ""), MAX_NAME),
		parentSpanId: idOf(value.parentSpanId, SPAN_ID_RE),
		spanId,
		startTime: dateOf(start),
		statusCode: enumOf(status.code, STATUS_CODES, 2),
		statusMessage: message,
		traceId,
	};
}

/**
 * Parses an OTLP/JSON `ExportTraceServiceRequest` into its resources, each
 * with its flattened attributes and its valid spans across every scope.
 * Invalid spans are skipped; past `MAX_SPANS_PER_REQUEST` the rest are too.
 *
 * @throws `OtlpError` when the body isn't an object with `resourceSpans`.
 */
export function parseOtlpTraces(body: unknown): ParsedResource[] {
	if (!(isRecord(body) && Array.isArray(body.resourceSpans))) {
		throw new OtlpError("Expected an OTLP/JSON body with resourceSpans");
	}
	let budget = MAX_SPANS_PER_REQUEST;
	const resources: ParsedResource[] = [];
	for (const entry of body.resourceSpans) {
		if (!isRecord(entry) || budget <= 0) {
			continue;
		}
		const resource = isRecord(entry.resource) ? entry.resource : {};
		const spans: ParsedSpan[] = [];
		for (const scope of listOf(entry.scopeSpans)) {
			const raw = isRecord(scope) ? listOf(scope.spans) : [];
			for (const candidate of raw.slice(0, budget)) {
				const span = parseSpan(candidate);
				if (span) {
					spans.push(span);
					budget -= 1;
				}
			}
		}
		resources.push({
			attributes: flattenAttributes(resource.attributes),
			spans,
		});
	}
	return resources;
}

/**
 * Which Homerun service a resource's spans belong to: the service named by
 * its `homerun.service.id` attribute, else the one whose slug is its
 * `service.name`, as long as that service has traces turned on or the
 * resource carries that service's CI span token (`homerun.pipeline`, checked
 * by `isPipeline`). Homerun's own services (`homerun`, `homerun-worker`)
 * belong to the instance, no service. Null drops the spans.
 */
export function spanOwner(
	attributes: Record<string, unknown>,
	services: TracedService[],
	isPipeline: (serviceId: string, value: unknown) => boolean = () => false,
): SpanOwner | null {
	const serviceId = attributes[SERVICE_ID_ATTRIBUTE];
	const name =
		typeof attributes["service.name"] === "string"
			? attributes["service.name"]
			: "";
	const found =
		(typeof serviceId === "string"
			? services.find((svc) => svc.id === serviceId)
			: undefined) ??
		(name ? services.find((svc) => svc.slug === name) : undefined);
	if (found) {
		return found.tracesEnabled ||
			isPipeline(found.id, attributes[PIPELINE_ATTRIBUTE])
			? { serviceId: found.id, serviceName: name || found.slug }
			: null;
	}
	return HOMERUN_SERVICE_NAMES.has(name)
		? { serviceId: null, serviceName: name }
		: null;
}
