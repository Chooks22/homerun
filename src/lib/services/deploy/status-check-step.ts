import { config } from "#lib/config.js";
import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import type { JobDTO } from "#lib/dto/job-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { DEPLOY_LOG_SCOPE, Logger } from "#lib/logger.js";
import {
	type CheckEvaluation,
	type CheckRound,
	checkRound,
	describeEvaluation,
} from "#lib/status-checks.js";
import { NotificationChannelService } from "../notification-channel.service.ts";
import { statusChecksMessage } from "../notification-messages.ts";
import { JobDeferredError } from "../queue/deferred.ts";
import { StatusCheckService } from "../status-check.service.ts";

const logger = new Logger(DEPLOY_LOG_SCOPE);

export const STATUS_CHECK_POLL_MS = 20_000;
export const STATUS_CHECK_TIMEOUT_MS = 30 * 60 * 1000;
export const STATUS_CHECK_GRACE_MS = 3 * 60 * 1000;

interface StatusCheckFailure {
	commit: string | null;
	evaluation: CheckEvaluation | null;
}

/**
 * Thrown when required git status checks block a git build from proceeding
 * (missing/unreadable checks, a timeout or a failing check). Carries enough
 * detail (`commit`, `evaluation`) for the caller to notify without
 * re-deriving it.
 */
export class StatusChecksFailedError extends Error {
	override name = "StatusChecksFailedError";
	readonly commit: string | null;
	readonly evaluation: CheckEvaluation | null;

	/** @param failure Carries the resolved commit and check evaluation so the caller can notify without re-deriving them. */
	constructor(message: string, failure: StatusCheckFailure) {
		super(message);
		this.commit = failure.commit;
		this.evaluation = failure.evaluation;
	}
}

interface StatusCheckContext {
	dep: DeploymentDTO;
	job: JobDTO;
	svc: ServiceDTO;
	userId: string;
}

/** Appends `line` to the deployment's log unless it's already the last line, so a wait repeated on every claim logs each change once. */
async function logChange(dep: DeploymentDTO, line: string): Promise<void> {
	if (dep.log.trimEnd().split("\n").at(-1) !== line) {
		await dep.appendLog(line);
	}
}

/**
 * The status-check gate a git build passes before its deploy changes
 * anything: checks the service's required status checks once on the ref's
 * commit, pinned on the first round and recorded on the deployment. While
 * they're pending (or the provider is briefly unreachable) the job goes back
 * in the queue for `STATUS_CHECK_POLL_MS`, holding nothing, until they settle
 * or `STATUS_CHECK_TIMEOUT_MS` passes. A job already waiting on its build
 * slot passed this gate and keeps the commit it passed on.
 *
 * @returns The commit the checks passed on, for the build to check out, or
 *   null when the service doesn't require checks.
 * @throws {JobDeferredError} While the checks are pending.
 * @throws {StatusChecksFailedError} When no checks are selected, the checks
 *   can't be read, they fail, or they time out.
 */
export async function gateStatusChecks(
	ctx: StatusCheckContext,
): Promise<string | null> {
	const { dep, job, svc } = ctx;
	const row = svc.toJSON();
	if (!(row.requireStatusChecks && row.gitUrl)) {
		return null;
	}
	if (job.deferral?.gate === "build-slot") {
		return dep.toJSON().gitCommit;
	}
	const required = row.requiredStatusChecks;
	if (required.length === 0) {
		throw new StatusChecksFailedError(
			"Status checks are required, but no checks are selected. Pick them on the Source tab.",
			{ commit: null, evaluation: null },
		);
	}
	const waiting =
		job.deferral?.gate === "status-checks" ? job.deferral.since : null;
	const waitedMs = waiting ? Date.now() - waiting.getTime() : 0;
	const ref = row.gitRef || "main";
	let commit = waiting ? dep.toJSON().gitCommit : null;
	try {
		const client = await StatusCheckService.clientFor(row.gitUrl, ctx.userId);
		if (!commit) {
			commit = await client.resolveCommit(ref);
			await dep.appendLog(
				`Checking status checks on ${ref}@${commit.slice(0, 7)}: ${required.join(", ")}`,
			);
			await dep.update({ gitCommit: commit, gitRef: ref });
		}
		const pinned = commit;
		const round = await checkRound({
			fetchChecks: () => client.checks(pinned),
			graceMs: STATUS_CHECK_GRACE_MS,
			required,
			timeoutMs: STATUS_CHECK_TIMEOUT_MS,
			waitedMs,
		});
		return await settle(ctx, round, pinned);
	} catch (err) {
		if (
			err instanceof StatusChecksFailedError ||
			err instanceof JobDeferredError
		) {
			throw err;
		}
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn(`Status checks unreadable: service=${svc.id} : ${reason}`);
		throw new StatusChecksFailedError(
			`Couldn't read status checks: ${reason}. The build will not carry on.`,
			{ commit, evaluation: null },
		);
	}
}

/** The deferral that puts a deploy back in the queue to look at its checks again. */
function checkAgain(message: string): JobDeferredError {
	return new JobDeferredError(
		message,
		"status-checks",
		new Date(Date.now() + STATUS_CHECK_POLL_MS),
	);
}

/**
 * Turns a `checkRound` outcome into either the pinned commit (on pass), a
 * deferral (still pending, or a transient provider error), or a
 * `StatusChecksFailedError` describing why the build can't proceed.
 */
async function settle(
	ctx: StatusCheckContext,
	round: CheckRound,
	commit: string,
): Promise<string> {
	if (round.outcome === "retry") {
		await logChange(
			ctx.dep,
			`Couldn't read status checks (${round.reason}), retrying.`,
		);
		throw checkAgain(round.reason);
	}
	const summary = describeEvaluation(round.evaluation);
	switch (round.outcome) {
		case "pass":
			await ctx.dep.appendLog(`Status checks passed (${summary}).`);
			logger.info(
				`Status checks passed: service=${ctx.svc.id} commit=${commit}`,
			);
			return commit;
		case "pending":
			await logChange(ctx.dep, `Waiting for status checks: ${summary}`);
			throw checkAgain(summary);
		case "timeout":
			throw new StatusChecksFailedError(
				`Status checks didn't finish within ${STATUS_CHECK_TIMEOUT_MS / 60_000} minutes (${summary}). The build will not carry on.`,
				{ commit, evaluation: round.evaluation },
			);
		default:
			throw new StatusChecksFailedError(
				`Required status checks didn't pass (${summary}). The build will not carry on.`,
				{ commit, evaluation: round.evaluation },
			);
	}
}

/**
 * Notifies every account that a build was blocked by failing status checks : an
 * in-app `NotificationDTO` plus any configured notification channel.
 */
export async function notifyStatusChecksFailed(
	svc: ServiceDTO,
	err: StatusChecksFailedError,
): Promise<void> {
	const stack = svc.stackId ? await StackDTO.get(svc.stackId) : null;
	NotificationDTO.notify({
		message: `"${svc.name}" was not built: ${err.message}`,
		serviceId: svc.id,
		type: "build_checks_failed",
	});
	NotificationChannelService.notify(
		statusChecksMessage(
			{
				commit: err.commit,
				failed: err.evaluation?.failed ?? [],
				missing: err.evaluation?.missing ?? [],
				origin: config.auth.origin ?? null,
				pending: err.evaluation?.pending ?? [],
				reason: err.message,
				service: svc.toJSON(),
				stackName: stack?.name ?? null,
			},
			new Date().toISOString(),
		),
	);
}
