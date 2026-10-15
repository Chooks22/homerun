import { JobDTO } from "#lib/dto/job-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { TrafficSampleDTO } from "#lib/dto/traffic-sample-dto.js";
import { Logger } from "#lib/logger.js";
import { SCALE_TO_ZERO_MAX_MINUTES, shouldSleep } from "#lib/scale-to-zero.js";
import { errorPagesPublished } from "./docker/error-pages.ts";
import { SWARM_REFRESH_SECONDS } from "./docker/swarm.ts";
import { DockerService } from "./docker.service.ts";
import { ServiceLifecycleService } from "./service-lifecycle.service.ts";

const logger = new Logger("ScaleToZero");

const WAKE_TIMEOUT_MS = 120_000;

const READY_POLL_MS = 500;

const ROUTE_SLACK_MS = 500;

/** How long a just-woken service still counts as waking, so a request racing Traefik's route gets the waking page rather than "not available yet". */
export const WAKE_GRACE_MS = 60_000;

/**
 * Scale to zero: stops a service that went its configured minutes without a
 * request through Traefik, and starts it again when a request for one of its
 * hosts lands on the error pages' catch-all router instead. A sleeping
 * service has `desiredState: "stopped"` and `sleepingSince` set, which is
 * what tells it apart from one stopped by hand.
 */
class ScaleToZeroServiceClass {
	#waking = new Map<string, Promise<boolean>>();

	/**
	 * Puts every idle service with scale to zero on to sleep, and marks awake
	 * a sleeping one something else started. Called by the stats sampler
	 * right after it recorded a minute of traffic, so the idle clock never
	 * reads a minute it couldn't see. Does nothing while the error pages'
	 * catch-all router isn't published, since nothing could wake a service
	 * then.
	 *
	 * @param watchingSince When the sampler's traffic baseline was taken.
	 */
	async sleepIdle(now: Date, watchingSince: Date): Promise<void> {
		if (!errorPagesPublished()) {
			return;
		}
		const services = (await ServiceDTO.listScaleToZero()).filter(
			(svc) => !this.#waking.has(svc.id),
		);
		await this.#reviveStarted(services);
		const candidates = services.filter((svc) => {
			const row = svc.toJSON();
			return (
				row.scaleToZeroMinutes !== null &&
				row.sleepingSince === null &&
				row.desiredState === "running" &&
				row.currentStatus === "running" &&
				row.dnsResolvable &&
				row.networkMode !== "host"
			);
		});
		if (candidates.length === 0) {
			return;
		}
		const ids = candidates.map((svc) => svc.id);
		const [lastRequests, busy] = await Promise.all([
			TrafficSampleDTO.lastRequestAt(
				ids,
				new Date(now.getTime() - SCALE_TO_ZERO_MAX_MINUTES * 60_000),
			),
			JobDTO.listActiveForServices(ids),
		]);
		const busyIds = new Set(busy.map((entry) => entry.serviceId));
		const idle = candidates.filter(
			(svc) =>
				!busyIds.has(svc.id) &&
				shouldSleep({
					lastRequestAt: lastRequests.get(svc.id) ?? null,
					minutes: svc.toJSON().scaleToZeroMinutes ?? SCALE_TO_ZERO_MAX_MINUTES,
					now,
					watchingSince,
					wokenAt: svc.toJSON().wokenAt,
				}),
		);
		await Promise.all(
			idle.map((svc) =>
				this.sleep(svc).catch((error: unknown) => {
					logger.error(
						`Couldn't put a service to sleep: service=${svc.id}`,
						error,
					);
				}),
			),
		);
	}

	/**
	 * Stops a service and marks it asleep, so the next request for it starts
	 * it again.
	 *
	 * @throws When the service has no container or swarm service.
	 */
	async sleep(svc: ServiceDTO): Promise<void> {
		await ServiceLifecycleService.stopService(svc);
		await svc.update({ currentStatus: "stopped", sleepingSince: new Date() });
		logger.info(
			`Service put to sleep: service=${svc.id} minutes=${svc.toJSON().scaleToZeroMinutes}`,
		);
	}

	/**
	 * Follows a change to a service's scale to zero setting: turning it on
	 * starts the idle clock now rather than at its last request, and turning
	 * it off while the service sleeps wakes it, since nothing else would.
	 */
	async configured(
		svc: ServiceDTO,
		previousMinutes: number | null,
	): Promise<void> {
		const { scaleToZeroMinutes, sleepingSince } = svc.toJSON();
		if (scaleToZeroMinutes && !previousMinutes) {
			await svc.update({ wokenAt: new Date() });
		}
		if (!scaleToZeroMinutes && sleepingSince) {
			void this.wake(svc);
		}
	}

	/** Whether a wake for this service has started and not settled yet. */
	isWaking(serviceId: string): boolean {
		return this.#waking.has(serviceId);
	}

	/**
	 * Starts a sleeping service and waits until Traefik routes it again: its
	 * container (or every swarm task) running and healthy, plus the time
	 * Traefik takes to see that. Concurrent calls for one service share the
	 * same wake. Never throws: a failed start puts it back to sleep so the
	 * next request tries again.
	 *
	 * @returns Whether it came up before the wake timeout.
	 */
	wake(svc: ServiceDTO): Promise<boolean> {
		const running = this.#waking.get(svc.id);
		if (running) {
			return running;
		}
		const wake = this.#wake(svc.id).finally(() => {
			this.#waking.delete(svc.id);
		});
		this.#waking.set(svc.id, wake);
		return wake;
	}

	/** `wake`'s body, for one service id. */
	async #wake(serviceId: string): Promise<boolean> {
		const svc = await ServiceDTO.get(serviceId);
		if (!svc) {
			return false;
		}
		const asleepSince = svc.toJSON().sleepingSince;
		if (asleepSince) {
			await svc.update({ sleepingSince: null, wokenAt: new Date() });
			try {
				await ServiceLifecycleService.startService(svc);
			} catch (error) {
				await svc.update({ sleepingSince: asleepSince });
				logger.error(`Couldn't wake a service: service=${svc.id}`, error);
				return false;
			}
		}
		const started = Date.now();
		const ready = await this.#waitUntilReady(svc, started + WAKE_TIMEOUT_MS);
		if (ready) {
			await svc.update({ currentStatus: "running" });
			logger.info(
				`Service woken: service=${svc.id} ms=${Date.now() - started}`,
			);
		} else {
			logger.warn(
				`Service didn't come up within ${WAKE_TIMEOUT_MS / 1000}s of a wake: service=${svc.id}`,
			);
		}
		return ready;
	}

	/** Polls the service until it's ready or `deadline` passes, then waits out Traefik's own lag. */
	async #waitUntilReady(svc: ServiceDTO, deadline: number): Promise<boolean> {
		while (Date.now() < deadline) {
			// oxlint-disable-next-line no-await-in-loop -- a poll, one check after another
			if (await this.#isReady(svc).catch(() => false)) {
				// oxlint-disable-next-line no-await-in-loop -- see above
				await Bun.sleep(
					svc.swarmServiceId
						? SWARM_REFRESH_SECONDS * 1000 + ROUTE_SLACK_MS
						: ROUTE_SLACK_MS,
				);
				return true;
			}
			// oxlint-disable-next-line no-await-in-loop -- see above
			await Bun.sleep(READY_POLL_MS);
		}
		return false;
	}

	/** Whether Traefik would route the service now: running, and healthy when it has a healthcheck. */
	async #isReady(svc: ServiceDTO): Promise<boolean> {
		if (svc.swarmServiceId) {
			return (
				(await DockerService.inspectSwarmServiceStatus(svc.swarmServiceId)) ===
				"running"
			);
		}
		if (!svc.containerId) {
			return false;
		}
		if ((await DockerService.inspectStatus(svc.containerId)) !== "running") {
			return false;
		}
		const health = await DockerService.containerHealth(svc.containerId);
		return !health || health.status === "healthy";
	}

	/** Clears the sleep of every sleeping service in `services` the status sync found running, started by hand or by Docker's restart policy. */
	async #reviveStarted(services: ServiceDTO[]): Promise<void> {
		const revived = services.filter(
			(svc) =>
				svc.toJSON().sleepingSince !== null && svc.currentStatus === "running",
		);
		await Promise.all(
			revived.map((svc) =>
				svc.update({
					desiredState: "running",
					sleepingSince: null,
					wokenAt: new Date(),
				}),
			),
		);
	}
}

export const ScaleToZeroService = new ScaleToZeroServiceClass();
