// Shared client-safe types. $lib/services/docker/containers.ts imports
// node:crypto and can't be imported from client-reachable code
// (SvelteKit blocks it) : so status-adjacent types that both server logic
// and UI components need live here instead.
export type ContainerStatus =
	| "pending"
	| "pulling"
	| "starting"
	| "running"
	| "stopped"
	| "failed"
	| "missing";

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type JobStage = "prepare" | "execute" | "finalize" | "finalizing";

export type JobType =
	| "backup"
	| "backup_restore"
	| "core_service"
	| "cron_job"
	| "deploy"
	| "docker_cleanup"
	| "image_scan"
	| "notification_delivery";

/** A job as the self-update blockers and `GET /api/v1/jobs` list it. */
export interface JobSummary {
	attempts: number;
	createdAt: Date;
	heartbeatAt: Date | null;
	id: string;
	serviceId: string | null;
	serviceName: string | null;
	stage: JobStage | null;
	stale: boolean;
	startedAt: Date | null;
	status: JobStatus;
	title: string;
	type: JobType;
	workerId: string | null;
}

export type RevisionHealth =
	| "watching"
	| "healthy"
	| "unhealthy"
	| "rolled_back";

export type StatusPageScope = "global" | "stack" | "custom";

export type NotificationChannelKind =
	| "webhook"
	| "discord"
	| "slack"
	| "telegram"
	| "email"
	| "browser";

export type NotificationEvent =
	| "build.started"
	| "deploy.started"
	| "build.failed"
	| "build.succeeded"
	| "build.checks_failed"
	| "deploy.unhealthy"
	| "deploy.rolled_back"
	| "update.failed"
	| "update.succeeded"
	| "update.available"
	| "deploy.failed"
	| "deploy.succeeded"
	| "image.vulnerable"
	| "service.down"
	| "service.up"
	| "resource.warning"
	| "resource.critical"
	| "resource.recovered"
	| "error.issue.new"
	| "error.issue.regressed"
	| "backup.failed"
	| "backup.succeeded"
	| "cron_job.failed"
	| "cron_job.succeeded"
	| "security.ip_banned"
	| "backup.storage_low";

export type PullPolicy = "always" | "missing" | "never";
