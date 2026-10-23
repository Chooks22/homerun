import { JobDTO } from "#lib/dto/job-dto.js";
import { APP_VERSION } from "#lib/server/app-version.js";
import { BaseScheduler } from "../cron/base-scheduler.ts";
import { closeCancelledDeploys } from "./cancelled-deploys.ts";
import { JobDeferredError } from "./deferred.ts";
import { jobHandlers } from "./handlers.ts";
import { STALE_JOB_MS } from "./stale.ts";
import { workerJobs } from "./worker-jobs/index.ts";

const POLL_MS = 1000;
const MAX_CONCURRENT_JOBS = 3;
const RETRY_BASE_MS = 10_000;
const STALL_CHECK_EVERY_MS = 30_000;
const ORPHAN_CHECK_EVERY_MS = 30_000;

const holdState = globalThis as unknown as { __job_worker_held?: boolean };

class JobWorkerClass extends BaseScheduler {
	protected readonly label = "Queue";
	protected readonly intervalMs = POLL_MS;
	readonly #inFlight = new Set<string>();
	readonly #stallWarned = new Set<string>();
	#nextStallCheck = 0;
	#nextOrphanCheck = 0;

	/** Whether the worker is held (see `hold()`): true means no new jobs will be claimed, held state is process-global and HMR-safe. */
	get held(): boolean {
		return holdState.__job_worker_held === true;
	}

	/** Whether at least one job is currently running in this process. */
	get busy(): boolean {
		return this.#inFlight.size > 0;
	}

	/** Stops the worker from claiming new jobs (already-running jobs finish normally). Used around operations that must not race a deploy, e.g. self-update. */
	hold(): void {
		holdState.__job_worker_held = true;
		this.logger.warn("Job worker held: no new jobs will start.");
	}

	/** Reverses `hold()`, letting the worker resume claiming jobs. */
	release(): void {
		holdState.__job_worker_held = false;
		this.logger.info("Job worker released.");
	}

	/** Recovers orphaned jobs from a previous process, finalizes whatever the Go worker has finished executing, then pumps as many queued jobs as capacity allows. No-op while held. */
	protected async tick(): Promise<void> {
		if (this.held) {
			return;
		}
		await this.#recoverOrphans();
		await this.#finalizeExecuted();
		await this.#pump();
		await this.#warnStalledExecutions();
	}

	/**
	 * Every `ORPHAN_CHECK_EVERY_MS` (and on the first tick), requeues running
	 * jobs in the app's own stages that nothing in this process is working on
	 * (`JobDTO.requeueOrphaned`, which leaves Go-leased executions alone): at
	 * boot that's whatever a previous process died in the middle of, later it's
	 * a job whose own bookkeeping failed, which used to sit in `running` until
	 * the next restart. A failed check is retried on the next tick.
	 */
	async #recoverOrphans(): Promise<void> {
		if (Date.now() < this.#nextOrphanCheck) {
			return;
		}
		const requeued = await JobDTO.requeueOrphaned([...this.#inFlight]);
		this.#nextOrphanCheck = Date.now() + ORPHAN_CHECK_EVERY_MS;
		if (requeued > 0) {
			this.logger.warn(
				`Requeued ${requeued} job(s) left running with nothing working on them.`,
			);
		}
	}

	/** Claims and dispatches queued jobs one at a time, recursively, until `MAX_CONCURRENT_JOBS` in-flight jobs are running or the queue is empty. No-op while held. */
	async #pump(): Promise<void> {
		if (this.held || this.#inFlight.size >= MAX_CONCURRENT_JOBS) {
			return;
		}
		const claimed = await JobDTO.claimNext();
		if (!claimed) {
			return;
		}
		this.#dispatch(claimed);
		await this.#pump();
	}

	/** Tracks `entry` as in-flight and starts `runJob` for it, removing it from `#inFlight` on settlement regardless of outcome. */
	#dispatch(entry: JobDTO): void {
		this.#inFlight.add(entry.id);
		this.logger.info(
			`Job started: type=${entry.type} job=${entry.id} attempt=${entry.attempts}/${entry.maxAttempts}`,
		);
		this.runJob(entry)
			.catch((err) => this.logger.error("Job bookkeeping failed", err))
			.finally(() => this.#inFlight.delete(entry.id));
	}

	/**
	 * Runs a freshly claimed job. A Go-executed type (`workerJobs`) only has its
	 * `prepare` step run here and is handed to the Go worker; anything else
	 * runs through its in-process handler (`jobHandlers`) and is marked
	 * succeeded with its result. A `JobDeferredError` puts it back in the
	 * queue; other failures go to `#recordFailure`. Never throws.
	 */
	async runJob(entry: JobDTO): Promise<void> {
		try {
			const workerJob = workerJobs[entry.type];
			if (workerJob) {
				await entry.handOff(await workerJob.prepare(entry));
				this.logger.info(
					`Job handed to the Go worker: type=${entry.type} job=${entry.id}`,
				);
				return;
			}
			const handler = jobHandlers[entry.type];
			if (!handler) {
				throw new Error(`No handler for job type ${entry.type}.`);
			}
			await JobDTO.stampWorkerVersion(entry.id, APP_VERSION);
			const result = await handler(entry);
			await entry.markSucceeded(result);
			this.logger.info(`Job succeeded: type=${entry.type} job=${entry.id}`);
		} catch (err) {
			if (err instanceof JobDeferredError) {
				await entry.defer(err.runAt, err.gate);
				this.logger.debug(
					`Job deferred to ${err.runAt.toISOString()}: type=${entry.type} job=${entry.id} : ${err.message}`,
				);
				return;
			}
			await this.#recordFailure(entry, err);
		}
	}

	/** Claims every job the Go worker has finished executing, serially, and finalizes each one in the background. */
	async #finalizeExecuted(): Promise<void> {
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- claims are serial so each sees the previous one's committed stage
			const executed = await JobDTO.claimFinalize();
			if (!executed) {
				return;
			}
			this.#inFlight.add(executed.id);
			this.finalizeJob(executed)
				.catch((err) => this.logger.error("Job bookkeeping failed", err))
				.finally(() => this.#inFlight.delete(executed.id));
		}
	}

	/**
	 * Runs a Go-executed job's `finalize` step with what the executor reported,
	 * marking the job succeeded with its result or delegating to
	 * `#recordFailure` when it throws. Never throws.
	 */
	async finalizeJob(entry: JobDTO): Promise<void> {
		this.#stallWarned.delete(entry.id);
		try {
			const workerJob = workerJobs[entry.type];
			if (!workerJob) {
				throw new Error(
					`Job type ${entry.type} isn't executed by the Go worker, nothing can finalize it.`,
				);
			}
			const result = await workerJob.finalize(
				entry,
				entry.executorResult,
				entry.executorError,
			);
			await entry.markSucceeded(result);
			this.logger.info(`Job succeeded: type=${entry.type} job=${entry.id}`);
		} catch (err) {
			await this.#recordFailure(entry, err);
		}
	}

	/** Logs one warning per job left in `execute` with no live Go worker for over two minutes. Doesn't fail it: a worker coming back picks it up. */
	async #warnStalledExecutions(): Promise<void> {
		if (Date.now() < this.#nextStallCheck) {
			return;
		}
		this.#nextStallCheck = Date.now() + STALL_CHECK_EVERY_MS;
		const stalled = await JobDTO.listStalledExecutions(
			new Date(Date.now() - STALE_JOB_MS),
		);
		for (const entry of stalled) {
			if (this.#stallWarned.has(entry.id)) {
				continue;
			}
			this.#stallWarned.add(entry.id);
			this.logger.warn(
				`Job waiting for a Go worker for over 2 minutes, is homerun-worker running? type=${entry.type} job=${entry.id}`,
			);
		}
	}

	/** Schedules an exponential-backoff retry if `entry` has attempts left, otherwise marks it failed and cancels any dependent jobs. */
	async #recordFailure(entry: JobDTO, err: unknown): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);

		if (entry.attempts < entry.maxAttempts) {
			const runAt = new Date(Date.now() + RETRY_BASE_MS * 2 ** entry.attempts);
			await entry.scheduleRetry(message, runAt);
			this.logger.warn(
				`Job failed, retrying at ${runAt.toISOString()}: type=${entry.type} job=${entry.id} : ${message}`,
			);
			return;
		}

		await entry.markFailed(message);
		const reason = `Cancelled because "${entry.title}" failed.`;
		await closeCancelledDeploys(
			await JobDTO.cancelDependents(entry.id, reason),
			reason,
		);
		this.logger.error(
			`Job failed: type=${entry.type} job=${entry.id} : ${message}`,
		);
	}
}

export const JobWorker = new JobWorkerClass();
