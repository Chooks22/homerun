import type { DeferGate } from "#lib/types.js";

/** What a deferred job waits on, and since when it has been waiting on it. */
export interface Deferral {
	gate: DeferGate;
	since: Date;
}

/** Thrown by a job's prepare step to put the job back in the queue until `runAt`, without counting it as a failed attempt. */
export class JobDeferredError extends Error {
	override name = "JobDeferredError";
	readonly gate: DeferGate;
	readonly runAt: Date;

	/**
	 * @param gate What the job waits on, so each wait keeps its own start time.
	 * @param runAt When the job may be claimed again.
	 */
	constructor(message: string, gate: DeferGate, runAt: Date) {
		super(message);
		this.gate = gate;
		this.runAt = runAt;
	}
}
