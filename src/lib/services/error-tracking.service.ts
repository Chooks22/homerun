import type { TraceMap } from "@jridgewell/trace-mapping";
import { config } from "#lib/config.js";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { ErrorEventDTO } from "#lib/dto/error-event-dto.js";
import { ErrorIssueDTO } from "#lib/dto/error-issue-dto.js";
import { ErrorProjectDTO } from "#lib/dto/error-project-dto.js";
import { ErrorSourceMapDTO } from "#lib/dto/error-source-map-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { RepositoryDTO } from "#lib/dto/repository-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import {
	type DsnProject,
	internalDsn,
	publicDsn,
	sentryEnv,
} from "#lib/error-tracking/dsn.js";
import {
	decodeBody,
	EnvelopeError,
	jsonPayload,
	parseEnvelope,
	sentryKeyOf,
} from "#lib/error-tracking/envelope.js";
import {
	normalizeEvent,
	type StoredErrorEvent,
} from "#lib/error-tracking/event.js";
import { groupingHash } from "#lib/error-tracking/grouping.js";
import { WindowRateLimiter } from "#lib/error-tracking/rate-limit.js";
import {
	isCommitSha,
	providerFromHost,
	repoWebUrl,
	type SourceProvider,
} from "#lib/error-tracking/source-links.js";
import {
	applySourceMaps,
	isMinifiedFrame,
	matchMapName,
	parseSourceMap,
} from "#lib/error-tracking/source-maps.js";
import { providerForGitUrl } from "#lib/git-clone-url.js";
import { Logger } from "#lib/logger.js";
import { deployEnvironment } from "#lib/release-channels.js";
import type { ErrorIssue, Service } from "#lib/server/db/schema.js";
import { dashboardRouterPlan } from "./docker/dashboard.ts";
import { DockerService } from "./docker.service.ts";
import { NotificationChannelService } from "./notification-channel.service.ts";
import { errorIssueMessage } from "./notification-messages.ts";

const logger = new Logger("ErrorTracking");

export const MAX_BODY_BYTES = 1024 * 1024;
export const EVENTS_PER_MINUTE = 120;
export const EVENTS_KEPT_PER_ISSUE = 100;
export const RETENTION_DAYS = 30;
export const NOTIFICATIONS_PER_HOUR = 10;
const SOURCE_MAP_CACHE_SIZE = 32;
const PRUNE_ISSUE_EVERY = 20;
const HOST_CACHE_MS = 5 * 60 * 1000;

const CORS_HEADERS = {
	"access-control-allow-headers":
		"content-type, content-encoding, x-sentry-auth, authorization, sentry-trace, baggage",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-origin": "*",
	"access-control-expose-headers":
		"x-sentry-error, x-sentry-rate-limits, retry-after",
	"access-control-max-age": "3600",
};

export type IngestKind = "envelope" | "store";

export interface SourceRepo {
	branch?: boolean;
	buildContext: string | null;
	commit: string;
	provider: SourceProvider;
	repoUrl: string;
}

function reply(
	status: number,
	body: unknown,
	extra: Record<string, string> = {},
): Response {
	const headers: Record<string, string> = {
		...CORS_HEADERS,
		"content-type": "application/json",
		...extra,
	};
	if (status >= 400 && body && typeof body === "object" && "detail" in body) {
		headers["x-sentry-error"] = String(body.detail);
	}
	return new Response(JSON.stringify(body), { headers, status });
}

async function readCapped(request: Request): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES) {
		return null;
	}
	if (!request.body) {
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.body) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

class ErrorTrackingServiceClass {
	readonly #ingestLimiter = new WindowRateLimiter(EVENTS_PER_MINUTE, 60_000);
	readonly #notifyLimiter = new WindowRateLimiter(
		NOTIFICATIONS_PER_HOUR,
		60 * 60 * 1000,
	);
	#host: { at: number; value: string | null } | null = null;
	readonly #sourceMaps = new Map<string, TraceMap>();

	/** The CORS preflight answer browser SDKs get before posting. */
	preflight(): Response {
		return new Response(null, { headers: CORS_HEADERS, status: 204 });
	}

	/**
	 * Serves one Sentry ingest request (`/api/<id>/envelope/` or the legacy
	 * `/api/<id>/store/`): checks the body size, decompresses it, finds the
	 * project and checks the key, rate-limits per project and stores every
	 * event it carries. Other item types (transactions, sessions, client
	 * reports, attachments) are accepted and dropped, so SDKs don't retry them.
	 * Every answer carries CORS headers for browser SDKs.
	 */
	async ingest(
		request: Request,
		url: URL,
		projectParam: string,
		kind: IngestKind,
	): Promise<Response> {
		const projectId = Number(projectParam);
		if (!Number.isSafeInteger(projectId) || projectId < 1) {
			return reply(404, { detail: "unknown project" });
		}
		const raw = await readCapped(request);
		if (!raw) {
			return reply(413, { detail: "request body too large" });
		}
		let items: unknown[];
		let envelopeDsn: unknown = null;
		try {
			const body = decodeBody(
				raw,
				request.headers.get("content-encoding"),
				MAX_BODY_BYTES,
			);
			if (kind === "store") {
				items = [jsonPayload(body)];
			} else {
				const envelope = parseEnvelope(body);
				envelopeDsn = envelope.header.dsn;
				items = envelope.items
					.filter((item) => item.type === "event")
					.map((item) => jsonPayload(item.payload));
			}
		} catch (error) {
			const detail =
				error instanceof EnvelopeError ? error.message : "invalid request body";
			return reply(400, { detail });
		}

		const key = sentryKeyOf({
			authHeader:
				request.headers.get("x-sentry-auth") ??
				request.headers.get("authorization"),
			envelopeDsn,
			url,
		});
		if (!key) {
			return reply(401, { detail: "missing authorization information" });
		}
		const project = await ErrorProjectDTO.getByProjectId(projectId);
		if (!project) {
			return reply(404, { detail: "unknown project" });
		}
		if (project.publicKey !== key || !project.enabled) {
			return reply(403, {
				detail: project.enabled ? "invalid api key" : "project disabled",
			});
		}
		if (items.length === 0) {
			return reply(200, {});
		}
		const retryAfter = this.#ingestLimiter.hit(String(projectId));
		if (retryAfter !== null) {
			return reply(
				429,
				{ detail: "rate limited" },
				{
					"retry-after": String(retryAfter),
					"x-sentry-rate-limits": `${retryAfter}::key`,
				},
			);
		}

		let lastId: string | null = null;
		for (const payload of items) {
			const event = normalizeEvent(payload, new Date());
			if (event) {
				// oxlint-disable-next-line no-await-in-loop -- events of one envelope are recorded in order
				const mapped = await this.#withSourceMaps(project.serviceId, event);
				// oxlint-disable-next-line no-await-in-loop -- events of one envelope are recorded in order
				await this.#record(project.serviceId, mapped);
				lastId = event.eventId;
			}
		}
		return reply(200, lastId ? { id: lastId } : {});
	}

	/**
	 * `event` with its minified browser frames mapped back to their source
	 * through the maps uploaded for its release, before it's grouped, so
	 * issues group on real function names. Parsed maps are cached by id (the
	 * last `SOURCE_MAP_CACHE_SIZE`); a map that doesn't parse is skipped and
	 * logged, and an event without a release or minified frames is untouched.
	 */
	async #withSourceMaps(
		serviceId: string,
		event: StoredErrorEvent,
	): Promise<StoredErrorEvent> {
		const urls = [
			...new Set(
				event.exceptions.flatMap((exception) =>
					exception.frames
						.filter(isMinifiedFrame)
						.map((frame) => frame.absPath ?? ""),
				),
			),
		];
		if (!event.release || urls.length === 0) {
			return event;
		}
		const rows = await ErrorSourceMapDTO.namesFor(serviceId, event.release);
		const names = rows.map((row) => row.name);
		const wanted = new Set(urls.map((url) => matchMapName(url, names)));
		const maps = new Map<string, TraceMap>();
		for (const row of rows.filter((entry) => wanted.has(entry.name))) {
			// oxlint-disable-next-line no-await-in-loop -- an event rarely spans more than a couple of bundles
			const map = await this.#loadSourceMap(row.id);
			if (map) {
				maps.set(row.name, map);
			}
		}
		return maps.size > 0 ? applySourceMaps(event, maps) : event;
	}

	/** A stored map, parsed and cached, null when it's gone or doesn't parse. */
	async #loadSourceMap(id: string): Promise<TraceMap | null> {
		const cached = this.#sourceMaps.get(id);
		if (cached) {
			this.#sourceMaps.delete(id);
			this.#sourceMaps.set(id, cached);
			return cached;
		}
		const content = await ErrorSourceMapDTO.content(id);
		if (!content) {
			return null;
		}
		try {
			const map = parseSourceMap(content);
			this.#sourceMaps.set(id, map);
			if (this.#sourceMaps.size > SOURCE_MAP_CACHE_SIZE) {
				const oldest = this.#sourceMaps.keys().next().value;
				if (oldest) {
					this.#sourceMaps.delete(oldest);
				}
			}
			return map;
		} catch (error) {
			logger.warn(`Unreadable source map skipped: id=${id}`, error);
			return null;
		}
	}

	/** Stores one event: skips a duplicate event id, upserts its issue, stores the event, trims the issue's history and notifies on a new or regressed issue. */
	async #record(serviceId: string, event: StoredErrorEvent): Promise<void> {
		if (await ErrorEventDTO.exists(serviceId, event.eventId)) {
			return;
		}
		const receivedAt = new Date();
		const recorded = await ErrorIssueDTO.record(
			serviceId,
			groupingHash(event),
			event,
			receivedAt,
		);
		await ErrorEventDTO.create(recorded.issue.id, serviceId, event, receivedAt);
		if (recorded.issue.count % PRUNE_ISSUE_EVERY === 0) {
			await ErrorEventDTO.pruneIssue(recorded.issue.id, EVENTS_KEPT_PER_ISSUE);
		}
		if (
			(recorded.created || recorded.regressed) &&
			recorded.issue.status !== "ignored"
		) {
			this.#notify(serviceId, recorded.issue, recorded.regressed);
		}
	}

	/** Sends the in-app and channel notifications for a new or regressed issue, at most `NOTIFICATIONS_PER_HOUR` of each kind a service, so a burst of new issues can't hide a regression; errors are logged, never thrown. */
	#notify(serviceId: string, issue: ErrorIssue, regressed: boolean): void {
		if (
			this.#notifyLimiter.hit(
				`${serviceId}:${regressed ? "regressed" : "new"}`,
			) !== null
		) {
			logger.info(
				`Error notification skipped, service over its hourly cap: service=${serviceId} issue=${issue.id}`,
			);
			return;
		}
		ServiceDTO.get(serviceId)
			.then((svc) => {
				if (!svc) {
					return;
				}
				NotificationDTO.notify({
					message: `"${svc.name}" ${regressed ? "error regressed" : "new error"}: ${issue.title}`,
					serviceId,
					type: "error_issue",
				});
				NotificationChannelService.notify(
					errorIssueMessage(
						{
							issue,
							origin: config.auth.origin ?? null,
							regressed,
							service: { id: svc.id, name: svc.name },
						},
						new Date().toISOString(),
					),
				);
			})
			.catch((err) => logger.warn("Couldn't send an error notification", err));
	}

	/** The dashboard container's name on the Homerun network, cached for a few minutes; null outside Docker. */
	async #internalHost(): Promise<string | null> {
		if (this.#host && Date.now() - this.#host.at < HOST_CACHE_MS) {
			return this.#host.value;
		}
		const self = await DockerService.selfContainer().catch(() => null);
		const plan = dashboardRouterPlan("dashboard", self);
		const value = plan.action === "write" ? plan.target : null;
		this.#host = { at: Date.now(), value };
		return value;
	}

	/** The public and internal DSNs of a project; either is null when it can't be built (no dashboard URL, not running in Docker). */
	async dsns(
		project: DsnProject,
		requestOrigin: string | null = null,
	): Promise<{ internal: string | null; public: string | null }> {
		const origin = config.auth.origin ?? requestOrigin;
		const host = await this.#internalHost();
		return {
			internal: host ? internalDsn(host, config.port, origin, project) : null,
			public: origin ? publicDsn(origin, project) : null,
		};
	}

	/**
	 * The `SENTRY_*` env a deploy injects for a service whose error tracking
	 * (its own, or its preview or canary parent's) is on with injection
	 * enabled: the internal DSN when chosen and available, else the public
	 * one. Null when there's nothing to inject.
	 */
	async deployEnv(
		svc: Service,
		release: string | null,
	): Promise<{ env: [string, string][]; releaseFromBuild: boolean } | null> {
		const project = await ErrorProjectDTO.getForService(
			svc.previewParentId ?? svc.id,
		);
		const row = project?.toJSON();
		if (!(row?.enabled && row.injectEnv)) {
			return null;
		}
		const dsns = await this.dsns(row);
		const dsn = (row.internalDsn ? dsns.internal : null) ?? dsns.public;
		if (!dsn) {
			return null;
		}
		return sentryEnv({
			dsn,
			environment: deployEnvironment(svc),
			release,
			userEnv: svc.envVars ?? {},
		});
	}

	/**
	 * Where an event's in-app frames link to: the repository linked to the
	 * service under Pipelines when there is one, any service included, else
	 * the one a git service builds from; at the event's release when that's a
	 * commit, else at the commit deployed when the event happened, else (a
	 * linked repository with nothing deployed from it) at its default branch.
	 * Null when neither the provider nor a ref can be worked out.
	 */
	async sourceRepo(
		svc: Service,
		event: Pick<StoredErrorEvent, "release" | "timestamp">,
	): Promise<SourceRepo | null> {
		const linked = svc.repositoryId
			? await RepositoryDTO.get(svc.repositoryId)
			: null;
		if (linked) {
			const commit = isCommitSha(event.release)
				? event.release
				: svc.buildSource === "git"
					? await DeploymentDTO.commitAt(svc.id, new Date(event.timestamp))
					: null;
			const ref = commit ?? linked.toJSON().defaultBranch;
			return ref
				? {
						branch: !commit,
						buildContext:
							svc.buildSource === "git" ? svc.gitBuildContext : null,
						commit: ref,
						provider: linked.providerKind,
						repoUrl: linked.webUrl,
					}
				: null;
		}
		if (svc.buildSource !== "git" || !svc.gitUrl) {
			return null;
		}
		const repoUrl = repoWebUrl(svc.gitUrl);
		if (!repoUrl) {
			return null;
		}
		const settings = await InstanceSettingsDTO.get();
		const provider =
			providerForGitUrl(
				repoUrl,
				settings.gitProviders.filter((candidate) => candidate.enabled),
			)?.kind ?? providerFromHost(new URL(repoUrl).host);
		const commit = isCommitSha(event.release)
			? event.release
			: await DeploymentDTO.commitAt(svc.id, new Date(event.timestamp));
		if (!(provider && commit)) {
			return null;
		}
		return {
			buildContext: svc.gitBuildContext,
			commit,
			provider,
			repoUrl,
		};
	}

	/** Deletes events past the retention window and resolved or ignored issues not seen within it. */
	async prune(now = new Date()): Promise<void> {
		const before = new Date(
			now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
		);
		await ErrorEventDTO.pruneOlderThan(before);
		await ErrorIssueDTO.pruneClosed(before);
	}
}

export const ErrorTrackingService = new ErrorTrackingServiceClass();
