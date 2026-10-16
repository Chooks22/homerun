import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { type NewTraceSpan, TraceSpanDTO } from "#lib/dto/trace-span-dto.js";
import { decodeBody, EnvelopeError } from "#lib/error-tracking/envelope.js";
import { Logger } from "#lib/logger.js";
import type { OtlpTraceRequest } from "#lib/pipelines/otlp.js";
import { OTEL_COLLECTOR_HOST, OTEL_HTTP_PORT } from "#lib/tracing/env.js";
import {
	otlpIngestToken,
	validOtlpAuthorization,
	validPipelineSpanToken,
} from "#lib/tracing/ingest-token.js";
import {
	OtlpError,
	type ParsedResource,
	PIPELINE_ATTRIBUTE,
	parseOtlpTraces,
	spanOwner,
	type TracedService,
} from "#lib/tracing/otlp.js";
import {
	MAX_TRACE_RETENTION_DAYS,
	MIN_TRACE_RETENTION_DAYS,
	retentionCutoff,
	tracingSettings,
} from "#lib/tracing/settings.js";
import { errorPagesTarget } from "./docker/error-pages.ts";
import type { OtelDesiredState } from "./docker/otel-container.ts";
import { DockerService } from "./docker.service.ts";

const logger = new Logger("Tracing");

export const MAX_OTLP_BODY_BYTES = 10 * 1024 * 1024;

const SERVICES_TTL_MS = 30_000;
const PRUNE_BATCH = 5000;

export interface CollectorStatus {
	appOrigin: string | null;
	enabled: boolean;
	retentionDays: number;
	running: boolean;
}

function reply(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

/** Reads a request body, or null once it passes `max` bytes, declared or streamed. */
async function readCapped(
	request: Request,
	max: number,
): Promise<Uint8Array | null> {
	if (Number(request.headers.get("content-length") ?? 0) > max) {
		return null;
	}
	if (!request.body) {
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.body) {
		size += chunk.byteLength;
		if (size > max) {
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * OpenTelemetry traces: Homerun's managed collector, the OTLP/JSON ingest it
 * exports to, and the retention pass. Spans are stored per service when the
 * service has traces turned on, and as Homerun's own when they come from the
 * worker or the app.
 */
class TracingServiceClass {
	#services: { at: number; list: TracedService[] } | null = null;

	/** Every service as the ingest maps spans to it, cached briefly since the collector posts in a steady stream. */
	async #tracedServices(): Promise<TracedService[]> {
		if (this.#services && Date.now() - this.#services.at < SERVICES_TTL_MS) {
			return this.#services.list;
		}
		const list = (await ServiceDTO.list()).map((svc) => {
			const row = svc.toJSON();
			return { id: row.id, slug: row.slug, tracesEnabled: row.tracesEnabled };
		});
		this.#services = { at: Date.now(), list };
		return list;
	}

	/** Forgets the cached service list, so a toggled service is picked up on the next export. */
	forgetServices(): void {
		this.#services = null;
	}

	/**
	 * Handles `POST /api/v1/otlp/v1/traces` from the collector: checks the
	 * bearer token, reads at most 10 MB (gzip or deflate included), parses
	 * OTLP/JSON, and stores each resource's spans under the service it maps
	 * to. Spans belonging to no traced service are dropped and still
	 * acknowledged, so the collector doesn't retry them.
	 */
	async ingest(request: Request): Promise<Response> {
		if (
			!validOtlpAuthorization(
				request.headers.get("authorization"),
				config.auth.secret,
			)
		) {
			return reply(401, { message: "Invalid or missing bearer token" });
		}
		const mediaType = request.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase();
		if (mediaType !== "application/json") {
			return reply(415, { message: "Only OTLP/JSON is accepted" });
		}
		const raw = await readCapped(request, MAX_OTLP_BODY_BYTES);
		if (!raw) {
			return reply(413, { message: "Request body too large" });
		}
		let resources: ReturnType<typeof parseOtlpTraces>;
		try {
			const body = decodeBody(
				raw,
				request.headers.get("content-encoding"),
				MAX_OTLP_BODY_BYTES,
			);
			resources = parseOtlpTraces(JSON.parse(new TextDecoder().decode(body)));
		} catch (error) {
			const message =
				error instanceof OtlpError || error instanceof EnvelopeError
					? error.message
					: "Invalid OTLP/JSON body";
			return reply(400, { message });
		}
		await this.#store(resources);
		return reply(200, {});
	}

	/** Stores each resource's spans under the service it maps to, dropping the ones no traced service owns. */
	async #store(resources: ParsedResource[]): Promise<void> {
		const services = await this.#tracedServices();
		const rows: NewTraceSpan[] = [];
		for (const resource of resources) {
			const owner = spanOwner(resource.attributes, services, (id, value) =>
				validPipelineSpanToken(value, config.auth.secret, id),
			);
			if (!owner) {
				continue;
			}
			const { [PIPELINE_ATTRIBUTE]: _token, ...resourceAttributes } =
				resource.attributes;
			for (const span of resource.spans) {
				rows.push({
					...span,
					resourceAttributes,
					serviceId: owner.serviceId,
					serviceName: owner.serviceName,
				});
			}
		}
		if (rows.length > 0) {
			await TraceSpanDTO.insertMany(rows);
		}
	}

	/**
	 * Sends spans Homerun builds itself (CI runs) through the collector over
	 * OTLP/HTTP when it's on, so they take the same path as a service's own,
	 * and stores them directly when it's off or doesn't answer within five
	 * seconds (the dev server, outside the Docker network).
	 *
	 * @returns Whether the collector took them.
	 */
	async exportSpans(body: OtlpTraceRequest): Promise<boolean> {
		if ((await this.settings()).collectorEnabled) {
			try {
				const response = await fetch(
					`http://${OTEL_COLLECTOR_HOST}:${OTEL_HTTP_PORT}/v1/traces`,
					{
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
						method: "POST",
						signal: AbortSignal.timeout(5000),
					},
				);
				if (response.ok) {
					return true;
				}
				logger.warn(
					`Collector refused CI spans with HTTP ${response.status}, storing them directly.`,
				);
			} catch (error) {
				logger.debug(
					`Collector unreachable, storing CI spans directly: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		await this.#store(parseOtlpTraces(body));
		return false;
	}

	/**
	 * Where the collector should export to and with which token. The app is
	 * reached the way Traefik reaches it for the login wall and the error
	 * pages: the origin of the forwardAuth address, so the dashboard's alias
	 * on the shared network in a container, `host.docker.internal` in dev.
	 *
	 * @throws When that address isn't a URL.
	 */
	desiredState(): OtelDesiredState {
		const appOrigin = errorPagesTarget(config.authCheckUrl);
		if (!appOrigin) {
			throw new Error(
				`Homerun's address on the Docker network (${config.authCheckUrl}) isn't a URL, so the collector couldn't reach it.`,
			);
		}
		return { appOrigin, token: otlpIngestToken(config.auth.secret) };
	}

	/** The collector toggle, whether its container runs, where it exports to and the trace retention. */
	async collectorStatus(): Promise<CollectorStatus> {
		const settings = await this.settings();
		const running = await DockerService.otelRunning().catch(() => false);
		return {
			appOrigin: errorPagesTarget(config.authCheckUrl),
			enabled: settings.collectorEnabled,
			retentionDays: settings.retentionDays,
			running,
		};
	}

	/** Whether the collector is turned on and how many days of spans are kept. */
	async settings(): Promise<{
		collectorEnabled: boolean;
		retentionDays: number;
	}> {
		return tracingSettings((await InstanceSettingsDTO.get()).toJSON());
	}

	/**
	 * Saves the collector toggle and the retention, then starts, updates or
	 * removes the collector container to match.
	 *
	 * @throws When the retention is out of range, or the container can't be
	 *   brought in line.
	 */
	async saveSettings(input: {
		collectorEnabled: boolean;
		retentionDays: number;
	}): Promise<void> {
		if (
			!Number.isInteger(input.retentionDays) ||
			input.retentionDays < MIN_TRACE_RETENTION_DAYS ||
			input.retentionDays > MAX_TRACE_RETENTION_DAYS
		) {
			throw new Error(
				`Keep traces between ${MIN_TRACE_RETENTION_DAYS} and ${MAX_TRACE_RETENTION_DAYS} days.`,
			);
		}
		const settings = await InstanceSettingsDTO.get();
		await settings.persistTracing({
			otelCollectorEnabled: input.collectorEnabled,
			traceRetentionDays: input.retentionDays,
		});
		await DockerService.reconcileOtel(
			input.collectorEnabled ? this.desiredState() : null,
		);
		logger.info(
			`Tracing settings saved: collector=${input.collectorEnabled} retention=${input.retentionDays}d`,
		);
	}

	/** Brings the collector back after a worker restart when it's turned on, with the current export address. */
	async reassertCollector(): Promise<void> {
		if (!(await this.settings()).collectorEnabled) {
			return;
		}
		await DockerService.reconcileOtel(this.desiredState());
	}

	/** Deletes spans older than the retention, in batches. */
	async prune(now = new Date()): Promise<void> {
		const { retentionDays } = await this.settings();
		const deleted = await TraceSpanDTO.pruneBefore(
			retentionCutoff(retentionDays, now),
			PRUNE_BATCH,
		);
		if (deleted > 0) {
			logger.info(
				`Pruned ${deleted} trace spans older than ${retentionDays} days.`,
			);
		}
	}
}

export const TracingService = new TracingServiceClass();
