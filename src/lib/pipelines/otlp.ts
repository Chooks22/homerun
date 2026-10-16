import { createHash } from "node:crypto";
import { PIPELINE_ATTRIBUTE, SERVICE_ID_ATTRIBUTE } from "#lib/tracing/otlp.js";
import { pipelineServiceName } from "./providers.ts";
import type { PipelineJob, PipelineProvider, PipelineStatus } from "./types.ts";

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export interface PipelineTraceInput {
	actor: string | null;
	attempt: number;
	billableMinutes: number;
	branch: string | null;
	commitSha: string | null;
	costUsd: number;
	createdAt: Date;
	event: string | null;
	externalId: string;
	finishedAt: Date | null;
	jobs: PipelineJob[];
	name: string;
	number: number | null;
	pipelineToken: string;
	provider: PipelineProvider;
	repositoryId: string;
	serviceId: string | null;
	status: PipelineStatus;
	title: string | null;
	url: string | null;
}

interface OtlpKeyValue {
	key: string;
	value:
		| { boolValue: boolean }
		| { doubleValue: number }
		| { intValue: string }
		| { stringValue: string };
}

export interface OtlpSpan {
	attributes: OtlpKeyValue[];
	endTimeUnixNano: string;
	kind: number;
	name: string;
	parentSpanId?: string;
	spanId: string;
	startTimeUnixNano: string;
	status: { code: number; message?: string };
	traceId: string;
}

export interface OtlpTraceRequest {
	resourceSpans: {
		resource: { attributes: OtlpKeyValue[] };
		scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
	}[];
}

function hex(seed: string, length: number): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function nanos(time: Date): string {
	return (BigInt(time.getTime()) * 1_000_000n).toString();
}

function attributes(
	values: Record<string, string | number | boolean | null>,
): OtlpKeyValue[] {
	const list: OtlpKeyValue[] = [];
	for (const [key, value] of Object.entries(values)) {
		if (value === null || value === "") {
			continue;
		}
		if (typeof value === "boolean") {
			list.push({ key, value: { boolValue: value } });
		} else if (typeof value === "number") {
			list.push({
				key,
				value: Number.isInteger(value)
					? { intValue: String(value) }
					: { doubleValue: value },
			});
		} else {
			list.push({ key, value: { stringValue: value } });
		}
	}
	return list;
}

function statusOf(status: PipelineStatus): { code: number; message?: string } {
	if (status === "success") {
		return { code: STATUS_OK };
	}
	if (status === "failure") {
		return { code: STATUS_ERROR, message: "failed" };
	}
	return status === "cancelled"
		? { code: STATUS_UNSET, message: "cancelled" }
		: { code: STATUS_UNSET };
}

/**
 * The trace id a run's spans share: stable across syncs of one finished
 * attempt so a re-export never duplicates them, and new for each attempt,
 * including a GitLab retry, which keeps its pipeline id and attempt but
 * finishes again.
 */
export function pipelineTraceId(input: {
	attempt: number;
	externalId: string;
	finishedAt: Date | null;
	provider: PipelineProvider;
	repositoryId: string;
}): string {
	return hex(
		`pipeline:${input.repositoryId}:${input.provider}:${input.externalId}:${input.attempt}:${input.finishedAt?.toISOString() ?? ""}`,
		32,
	);
}

/**
 * One finished run as an OTLP/JSON trace: a root span from queued to
 * finished, a span per job of its latest attempt that ran, and a span per
 * step under its job.
 * Ids derive from the run so exporting it twice stores nothing new. The
 * resource names the service the trace is filed under (none: Homerun's own
 * traces) and carries the matching CI span token, so the ingest keeps them
 * whether or not that service's own traces are on. Null when the run hasn't
 * finished.
 */
export function buildPipelineTrace(
	input: PipelineTraceInput,
): OtlpTraceRequest | null {
	if (!input.finishedAt) {
		return null;
	}
	const traceId = pipelineTraceId(input);
	const rootId = hex(`${traceId}:run`, 16);
	const end = input.finishedAt;
	const spans: OtlpSpan[] = [
		{
			attributes: attributes({
				"cicd.pipeline.name": input.name,
				"cicd.pipeline.result": input.status,
				"cicd.pipeline.run.id": input.externalId,
				"cicd.pipeline.run.url.full": input.url,
				"homerun.pipeline.billable_minutes": input.billableMinutes,
				"homerun.pipeline.cost_usd": input.costUsd,
				"homerun.pipeline.run.attempt": input.attempt,
				"homerun.pipeline.run.number": input.number,
				"homerun.pipeline.trigger": input.event,
				"vcs.ref.head.name": input.branch,
				"vcs.ref.head.revision": input.commitSha,
				"vcs.change.title": input.title,
				"enduser.id": input.actor,
			}),
			endTimeUnixNano: nanos(end),
			kind: SPAN_KIND_INTERNAL,
			name: input.name,
			spanId: rootId,
			startTimeUnixNano: nanos(input.createdAt),
			status: statusOf(input.status),
			traceId,
		},
	];
	for (const [index, job] of input.jobs.entries()) {
		if (!job.startedAt || job.attempt !== input.attempt) {
			continue;
		}
		const jobId = hex(`${traceId}:job:${index}:${job.name}`, 16);
		spans.push({
			attributes: attributes({
				"cicd.pipeline.task.name": job.name,
				"cicd.pipeline.task.run.result": job.status,
				"cicd.pipeline.task.run.url.full": job.url,
				"cicd.worker.name": job.runner,
				"homerun.pipeline.billable_minutes": job.billableMinutes,
				"homerun.pipeline.cost_usd": job.costUsd,
				"homerun.pipeline.runner_labels": job.labels.join(","),
				"homerun.pipeline.stage": job.stage,
			}),
			endTimeUnixNano: nanos(new Date(job.finishedAt ?? end)),
			kind: SPAN_KIND_INTERNAL,
			name: job.name,
			parentSpanId: rootId,
			spanId: jobId,
			startTimeUnixNano: nanos(new Date(job.startedAt)),
			status: statusOf(job.status),
			traceId,
		});
		for (const [stepIndex, step] of job.steps.entries()) {
			if (!step.startedAt) {
				continue;
			}
			spans.push({
				attributes: attributes({
					"cicd.pipeline.task.name": job.name,
					"cicd.pipeline.task.step.result": step.status,
				}),
				endTimeUnixNano: nanos(
					new Date(step.finishedAt ?? job.finishedAt ?? end),
				),
				kind: SPAN_KIND_INTERNAL,
				name: step.name,
				parentSpanId: jobId,
				spanId: hex(`${jobId}:step:${stepIndex}:${step.name}`, 16),
				startTimeUnixNano: nanos(new Date(step.startedAt)),
				status: statusOf(step.status),
				traceId,
			});
		}
	}
	return {
		resourceSpans: [
			{
				resource: {
					attributes: attributes({
						[PIPELINE_ATTRIBUTE]: input.pipelineToken,
						[SERVICE_ID_ATTRIBUTE]: input.serviceId,
						"service.name": pipelineServiceName(input.provider),
					}),
				},
				scopeSpans: [{ scope: { name: "homerun.pipelines" }, spans }],
			},
		],
	};
}
