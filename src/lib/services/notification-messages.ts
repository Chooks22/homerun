import { stripAnsi } from "#lib/ansi.js";
import { type Capacity, usedPercent } from "#lib/backup-capacity.js";
import { isPhaseLine } from "#lib/deploy-phases.js";
import { type DeployTrigger, deployTriggerLabel } from "#lib/deploy-trigger.js";
import { formatBytes } from "#lib/formatting.js";
import {
	countsLine,
	type ImageScanFinding,
	type SeverityCounts,
} from "#lib/image-scan.js";
import type {
	ImageUpdateAvailable,
	ImageUpdateTrial,
} from "#lib/image-versions.js";
import { type IpIntel, intelSummary } from "#lib/ip-intel.js";
import {
	deployEvent,
	deployStartedEvent,
	deployTitle,
} from "#lib/notification-events.js";
import type { Deployment, Service } from "#lib/server/db/schema.js";
import type { NotificationEvent } from "#lib/types.js";

const LOG_TAIL_LINES = 15;

export interface MessageField {
	/** Whether a channel may lay it out beside others; decided from its length when unset. */
	inline?: boolean;
	name: string;
	value: string;
}

export interface ChannelMessage {
	detail: string | null;
	event: NotificationEvent;
	fields: MessageField[];
	link: string | null;
	/** Null for a message about the whole server rather than one service. */
	serviceId: string | null;
	serviceName: string | null;
	timestamp: string;
	title: string;
}

export interface DeployMessageInput {
	deployment: Pick<
		Deployment,
		| "errorMessage"
		| "finishedAt"
		| "gitCommit"
		| "gitRef"
		| "imageDigest"
		| "log"
		| "startedAt"
	>;
	origin: string | null;
	stackName: string | null;
	publicUrl: string | null;
	service: Pick<
		Service,
		"buildSource" | "gitRef" | "gitUrl" | "id" | "image" | "name" | "tag"
	>;
	trigger: DeployTrigger;
}

export interface UptimeMessageInput {
	detail: string | null;
	kind: "internal" | "external";
	ok: boolean;
	origin: string | null;
	publicHost: string | null;
	service: Pick<Service, "id" | "name">;
}

/** Joins `origin` and `path` into an absolute dashboard link, or null when no origin is configured to link back to. */
export function dashboardLink(
	origin: string | null,
	path: string,
): string | null {
	return origin ? `${origin.replace(/\/$/, "")}${path}` : null;
}

/** Formats the elapsed time between two timestamps as `"1m 05s"`/`"42s"`, or null when either is missing. */
export function formatDuration(
	startedAt: Date | null,
	finishedAt: Date | null,
): string | null {
	if (!(startedAt && finishedAt)) {
		return null;
	}
	const totalSeconds = Math.max(
		0,
		Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
	);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0
		? `${minutes}m ${String(seconds).padStart(2, "0")}s`
		: `${seconds}s`;
}

/** The last `LOG_TAIL_LINES` lines of a deploy log, ANSI-stripped and with phase markers and the error message line itself filtered out. */
export function logTail(log: string | null, errorMessage: string | null) {
	const lines = stripAnsi(log ?? "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line && !isPhaseLine(line) && line !== errorMessage);
	return lines.slice(-LOG_TAIL_LINES).join("\n");
}

/** The repository/branch/commit fields for a git-built service, or the image/digest fields for a bring-your-own-image one. */
function sourceFields(
	service: DeployMessageInput["service"],
	deployment: DeployMessageInput["deployment"],
): MessageField[] {
	if (service.buildSource === "git") {
		const fields: MessageField[] = [
			{ name: "Repository", value: service.gitUrl ?? "unknown" },
			{
				name: "Branch",
				value: deployment.gitRef ?? service.gitRef ?? "main",
			},
		];
		if (deployment.gitCommit) {
			fields.push({ name: "Commit", value: deployment.gitCommit.slice(0, 7) });
		}
		return fields;
	}
	const fields: MessageField[] = [
		{ name: "Image", value: `${service.image}:${service.tag}` },
	];
	if (deployment.imageDigest) {
		fields.push({
			name: "Digest",
			value: deployment.imageDigest.replace(/^(sha256:)?(.{12}).*$/, "$1$2"),
		});
	}
	return fields;
}

/** Builds the notification channel message for a deploy's outcome, with source/duration/URL fields and, on failure, a log-tail detail. */
export function deployMessage(
	input: DeployMessageInput,
	ok: boolean,
	timestamp: string,
): ChannelMessage {
	const { deployment, service } = input;
	const event = deployEvent(service.buildSource, input.trigger, ok);
	const fields: MessageField[] = [];
	if (input.stackName) {
		fields.push({ name: "Stack", value: input.stackName });
	}
	fields.push({
		name: "Trigger",
		value: deployTriggerLabel(input.trigger),
	});
	fields.push(...sourceFields(service, deployment));
	const duration = formatDuration(deployment.startedAt, deployment.finishedAt);
	if (duration) {
		fields.push({ name: "Duration", value: duration });
	}
	if (ok && input.publicUrl) {
		fields.push({ name: "URL", value: input.publicUrl });
	}

	let detail: string | null = null;
	if (!ok) {
		const tail = logTail(deployment.log, deployment.errorMessage);
		detail = [deployment.errorMessage ?? "Unknown error.", tail]
			.filter(Boolean)
			.join("\n\n");
	}

	return {
		detail,
		event,
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/environments/revisions`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: deployTitle(event, service.name),
	};
}

/** Builds the notification channel message for a deploy that just started: `build.started` for a git build, `deploy.started` otherwise. */
export function deployStartedMessage(
	input: DeployMessageInput & { rollback: boolean },
	timestamp: string,
): ChannelMessage {
	const { deployment, service } = input;
	const event = deployStartedEvent(
		service.buildSource,
		input.trigger,
		input.rollback,
	);
	const fields: MessageField[] = [];
	if (input.stackName) {
		fields.push({ name: "Stack", value: input.stackName });
	}
	fields.push({
		name: "Trigger",
		value: input.rollback ? "Rollback" : deployTriggerLabel(input.trigger),
	});
	fields.push(...sourceFields(service, deployment));
	return {
		detail: null,
		event,
		fields,
		link: dashboardLink(input.origin, `/services/${service.id}`),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: deployTitle(event, service.name),
	};
}

export interface ImageScanMessageInput {
	counts: SeverityCounts;
	findings: ImageScanFinding[];
	imageRef: string;
	origin: string | null;
	service: Pick<Service, "id" | "name">;
}

const TOP_CRITICAL_LINES = 10;

/** Builds the notification channel message for a scan that found critical vulnerabilities, listing up to `TOP_CRITICAL_LINES` of them. */
export function imageScanMessage(
	input: ImageScanMessageInput,
	timestamp: string,
): ChannelMessage {
	const { service } = input;
	const critical = input.findings
		.filter((finding) => finding.severity === "CRITICAL")
		.slice(0, TOP_CRITICAL_LINES)
		.map(
			(finding) =>
				`${finding.id} ${finding.pkg} ${finding.installedVersion}${finding.fixedVersion ? ` (fixed in ${finding.fixedVersion})` : ""}`,
		);
	return {
		detail: critical.length > 0 ? critical.join("\n") : null,
		event: "image.vulnerable",
		fields: [
			{ name: "Image", value: input.imageRef },
			{ name: "Findings", value: countsLine(input.counts) },
		],
		link: dashboardLink(input.origin, `/services/${service.id}/security`),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: `${service.name} has ${input.counts.critical} critical ${input.counts.critical === 1 ? "vulnerability" : "vulnerabilities"}`,
	};
}

/** Builds the notification channel message for an uptime probe's up/down transition. */
export function uptimeMessage(
	input: UptimeMessageInput,
	timestamp: string,
): ChannelMessage {
	const { service } = input;
	const fields: MessageField[] = [
		{
			name: "Probe",
			value:
				input.kind === "internal"
					? "Internal (Docker network)"
					: "External (public URL)",
		},
	];
	if (input.kind === "external" && input.publicHost) {
		fields.push({ name: "Host", value: input.publicHost });
	}
	return {
		detail: input.detail,
		event: input.ok ? "service.up" : "service.down",
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/observability/events`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: `${service.name} ${input.ok ? "recovered" : "is down"}`,
	};
}

export interface BackupCapacityMessageInput {
	capacity: Capacity;
	destinationId: string;
	name: string;
	origin: string | null;
	thresholdPercent: number;
}

/** Builds the notification channel message for a backup destination past its usage threshold. */
export function backupCapacityMessage(
	input: BackupCapacityMessageInput,
	timestamp: string,
): ChannelMessage {
	const percent = Math.round(usedPercent(input.capacity));
	return {
		detail: `Backups to it may start failing once it's full. The alert threshold is ${input.thresholdPercent}%.`,
		event: "backup.storage_low",
		fields: [
			{
				name: "Used",
				value: `${formatBytes(input.capacity.usedBytes)} (${percent}%)`,
			},
			{ name: "Free", value: formatBytes(input.capacity.freeBytes) },
			{ name: "Size", value: formatBytes(input.capacity.totalBytes) },
		],
		link: dashboardLink(
			input.origin,
			`/s3-destinations/${input.destinationId}`,
		),
		serviceId: null,
		serviceName: null,
		timestamp,
		title: `${input.name} is ${percent}% full`,
	};
}

export interface IpBanMessageInput {
	expiresAt: Date | null;
	host: string | null;
	intel: IpIntel | null;
	ip: string;
	origin: string | null;
	reason: string;
	userAgent: string | null;
}

/** Builds the notification channel message for an address banned for hitting blocked paths. */
export function ipBanMessage(
	input: IpBanMessageInput,
	timestamp: string,
): ChannelMessage {
	const fields: MessageField[] = [
		{ name: "Address", value: input.ip },
		{
			name: "Until",
			value: input.expiresAt ? input.expiresAt.toISOString() : "Lifted by hand",
		},
	];
	if (input.host) {
		fields.push({ name: "Host", value: input.host });
	}
	const network = intelSummary(input.intel);
	if (network) {
		fields.push({ name: "Network", value: network });
	}
	if (input.intel?.abuseEmail) {
		fields.push({ name: "Abuse contact", value: input.intel.abuseEmail });
	}
	if (input.userAgent) {
		fields.push({ name: "User agent", value: input.userAgent });
	}
	return {
		detail: input.reason,
		event: "security.ip_banned",
		fields,
		link: dashboardLink(input.origin, "/monitoring/blocked"),
		serviceId: null,
		serviceName: null,
		timestamp,
		title: `${input.ip} banned`,
	};
}

export interface StatusChecksMessageInput {
	commit: string | null;
	failed: string[];
	missing: string[];
	origin: string | null;
	pending: string[];
	reason: string;
	service: Pick<Service, "gitRef" | "gitUrl" | "id" | "name">;
	stackName: string | null;
}

/** Builds the notification channel message for a git build that was stopped by failing/missing/pending required status checks. */
export function statusChecksMessage(
	input: StatusChecksMessageInput,
	timestamp: string,
): ChannelMessage {
	const { service } = input;
	const fields: MessageField[] = [];
	if (input.stackName) {
		fields.push({ name: "Stack", value: input.stackName });
	}
	fields.push(
		{ name: "Repository", value: service.gitUrl ?? "unknown" },
		{ name: "Branch", value: service.gitRef ?? "main" },
	);
	if (input.commit) {
		fields.push({ name: "Commit", value: input.commit.slice(0, 7) });
	}
	const checks: Array<[string, string[]]> = [
		["Failed checks", input.failed],
		["Never reported", input.missing],
		["Still running", input.pending],
	];
	for (const [name, names] of checks) {
		if (names.length > 0) {
			fields.push({ name, value: names.join(", ") });
		}
	}
	return {
		detail: `${input.reason}\n\nThe build will not carry on. Fix the checks and redeploy.`,
		event: "build.checks_failed",
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/environments/revisions`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: `${service.name} was not built: status checks failed`,
	};
}

export interface RevisionHealthMessageInput {
	origin: string | null;
	reason: string;
	revision: Pick<Deployment, "gitCommit" | "id" | "imageRef">;
	rolledBackTo: Pick<Deployment, "gitCommit" | "id" | "imageRef"> | null;
	service: Pick<Service, "id" | "name">;
	skipReason: string | null;
}

function revisionLabel(
	revision: Pick<Deployment, "gitCommit" | "id" | "imageRef">,
): string {
	const commit = revision.gitCommit
		? ` @ ${revision.gitCommit.slice(0, 7)}`
		: "";
	return `${revision.imageRef ?? revision.id.slice(0, 8)}${commit}`;
}

/** Builds the notification channel message for a revision that failed its health checks, noting the rollback target if one was applied. */
export function revisionHealthMessage(
	input: RevisionHealthMessageInput,
	timestamp: string,
): ChannelMessage {
	const { rolledBackTo, service } = input;
	const fields: MessageField[] = [
		{ name: "Unhealthy revision", value: revisionLabel(input.revision) },
	];
	if (rolledBackTo) {
		fields.push({ name: "Rolled back to", value: revisionLabel(rolledBackTo) });
	}
	const detail = [input.reason, input.skipReason].filter(Boolean).join("\n\n");
	return {
		detail,
		event: rolledBackTo ? "deploy.rolled_back" : "deploy.unhealthy",
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/environments/revisions`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: rolledBackTo
			? `${service.name} was rolled back: the new revision is unhealthy`
			: `${service.name}'s new revision is unhealthy`,
	};
}

/**
 * Prefixes a message's title with the stack its service belongs to
 * ("Vortex › Server was built and deployed"), so services with generic names
 * say which project they're from. Unchanged without a stack, or when the title
 * already starts with it.
 */
export function withStackTitle(
	message: ChannelMessage,
	stackName: string | null,
): ChannelMessage {
	if (!stackName || message.title.startsWith(`${stackName} › `)) {
		return message;
	}
	return { ...message, title: `${stackName} › ${message.title}` };
}

export interface ErrorIssueMessageInput {
	issue: {
		count: number;
		culprit: string | null;
		id: string;
		lastEnvironment: string | null;
		lastRelease: string | null;
		level: string;
		title: string;
	};
	origin: string | null;
	regressed: boolean;
	service: Pick<Service, "id" | "name">;
}

/** Builds the notification channel message for a new or regressed error issue. */
export function errorIssueMessage(
	input: ErrorIssueMessageInput,
	timestamp: string,
): ChannelMessage {
	const { issue, service } = input;
	const fields: MessageField[] = [
		{ name: "Level", value: issue.level },
		{ name: "Events", value: String(issue.count) },
	];
	if (issue.culprit) {
		fields.push({ name: "Culprit", value: issue.culprit });
	}
	if (issue.lastEnvironment) {
		fields.push({ name: "Environment", value: issue.lastEnvironment });
	}
	if (issue.lastRelease) {
		fields.push({ name: "Release", value: issue.lastRelease });
	}
	return {
		detail: issue.title,
		event: input.regressed ? "error.issue.regressed" : "error.issue.new",
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/observability/errors/${issue.id}`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: `${service.name}: ${input.regressed ? "error regressed" : "new error"}`,
	};
}

export interface BackupMessageInput {
	attempts: number;
	error: string | null;
	key: string | null;
	ok: boolean;
	origin: string | null;
	scheduled: boolean;
	sizeBytes: number | null;
	volume: { id: string; name: string };
}

/** Formats a byte count as MiB or GiB for a message field. */
function formatSize(bytes: number): string {
	const mib = bytes / (1 << 20);
	return mib >= 1024
		? `${(mib / 1024).toFixed(1)} GiB`
		: `${mib.toFixed(1)} MiB`;
}

/** Builds the notification channel message for a volume backup's final outcome, its error as the detail when it failed. */
export function backupMessage(
	input: BackupMessageInput,
	timestamp: string,
): ChannelMessage {
	const { volume } = input;
	const fields: MessageField[] = [
		{ name: "Trigger", value: input.scheduled ? "Scheduled" : "Manual" },
	];
	if (input.key) {
		fields.push({ name: "Key", value: input.key });
	}
	if (input.sizeBytes !== null) {
		fields.push({ name: "Size", value: formatSize(input.sizeBytes) });
	}
	if (input.attempts > 1) {
		fields.push({ name: "Attempts", value: String(input.attempts) });
	}
	return {
		detail: input.ok ? null : (input.error ?? "Backup failed."),
		event: input.ok ? "backup.succeeded" : "backup.failed",
		fields,
		link: dashboardLink(input.origin, `/storage/${volume.id}`),
		serviceId: null,
		serviceName: null,
		timestamp,
		title: input.ok
			? `${volume.name} was backed up`
			: `Backup of ${volume.name} failed`,
	};
}

export interface CronJobMessageInput {
	job: { id: string; name: string };
	origin: string | null;
	outcome: {
		error: string | null;
		exitCode: number | null;
		output: string;
		success: boolean;
	};
	scheduled: boolean;
}

/** Builds the notification channel message for a cron job run, the error and the tail of its output as the detail when it failed. */
export function cronJobMessage(
	input: CronJobMessageInput,
	timestamp: string,
): ChannelMessage {
	const { job, outcome } = input;
	const fields: MessageField[] = [
		{ name: "Trigger", value: input.scheduled ? "Scheduled" : "Manual" },
	];
	if (outcome.exitCode !== null) {
		fields.push({ name: "Exit code", value: String(outcome.exitCode) });
	}
	const tail = stripAnsi(outcome.output)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(-LOG_TAIL_LINES)
		.join("\n");
	return {
		detail: outcome.success
			? null
			: [outcome.error ?? "The cron job failed.", tail]
					.filter(Boolean)
					.join("\n\n"),
		event: outcome.success ? "cron_job.succeeded" : "cron_job.failed",
		fields,
		link: dashboardLink(input.origin, `/cron-jobs/${job.id}`),
		serviceId: null,
		serviceName: null,
		timestamp,
		title: outcome.success ? `${job.name} ran` : `${job.name} failed`,
	};
}

const SHORT_DIGEST_RE = /^(sha256:)?(.{12}).*$/;

export interface UpdateAvailableMessageInput {
	currentTag: string;
	image: string;
	origin: string | null;
	service: { id: string; name: string };
	trial: ImageUpdateTrial | null;
	update: ImageUpdateAvailable;
}

/** Builds the notification channel message for a newer image found by an update check, with its trial run's outcome when one ran. */
export function updateAvailableMessage(
	input: UpdateAvailableMessageInput,
	timestamp: string,
): ChannelMessage {
	const { service, trial, update } = input;
	const sameTag = update.tag === input.currentTag;
	const fields: MessageField[] = [
		{ name: "Running", value: `${input.image}:${input.currentTag}` },
		{
			name: "Available",
			value: sameTag
				? `${input.image}:${update.tag} (new digest ${update.digest?.replace(SHORT_DIGEST_RE, "$1$2") ?? "unknown"})`
				: `${input.image}:${update.tag}`,
		},
	];
	if (trial) {
		fields.push({
			name: "Trial run",
			value: trial.status === "passed" ? "Started cleanly" : "Failed",
		});
	}
	return {
		detail: trial?.status === "failed" ? trial.message : null,
		event: "update.available",
		fields,
		link: dashboardLink(
			input.origin,
			`/services/${service.id}/environments/source`,
		),
		serviceId: service.id,
		serviceName: service.name,
		timestamp,
		title: sameTag
			? `${service.name} has a newer ${update.tag} image`
			: `${service.name} can update to ${update.tag}`,
	};
}
