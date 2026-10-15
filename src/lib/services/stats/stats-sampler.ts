import { ServiceDTO } from "#lib/dto/service-dto.js";
import {
	type NewStatSampleInput,
	StatSampleDTO,
} from "#lib/dto/stat-sample-dto.js";
import { TrafficSampleDTO } from "#lib/dto/traffic-sample-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import {
	counterDelta,
	countersBySlug,
	parseTraefikMetrics,
	type TrafficCounters,
} from "#lib/traffic-metrics.js";
import { CapacityService } from "../capacity.service.ts";
import { BaseScheduler } from "../cron/base-scheduler.ts";
import type { ContainerSample } from "../docker/containers.ts";
import { sumReplicaSamples } from "../docker/swarm-replicas.ts";
import { DockerService } from "../docker.service.ts";
import { ScaleToZeroService } from "../scale-to-zero.service.ts";
import { SystemStatsService } from "../system-stats.service.ts";
import { WorkstationService } from "../workstation.service.ts";

/** One in this many ticks also prunes, the same amortized shape AppLogDTO/NotificationDTO use. */
const PRUNE_EVERY_TICKS = 60;

/**
 * Writes one `stat_sample` row per minute for the host and for every
 * service with a running container (or, in swarm mode, the sum over its
 * replicas running on this host), which is what the dashboard's and a
 * service's own resource graphs read back. Nothing else records history :
 * the Host Resources panel polls live values and keeps none. Each host
 * sample is also checked against the resource thresholds (`CapacityService`),
 * and each tick also records the requests every service served, from
 * Traefik's metrics, then puts the services scale to zero finds idle to
 * sleep.
 */
export class StatsSampler extends BaseScheduler {
	protected readonly label = "Stats";

	protected readonly runOnStart = true;

	#ticks = 0;

	#lastTraffic: Map<string, TrafficCounters> | null = null;

	#trafficSince: Date | null = null;

	/**
	 * Reads Traefik's request counters and records what each running
	 * service served since the last read (`TrafficSampleDTO`). The first
	 * read after a start only sets the baseline, since the counters are
	 * cumulative. Skipped quietly when Traefik's metrics can't be read.
	 *
	 * @returns Whether a minute of traffic was recorded, so idle services can
	 * be judged on it.
	 */
	async #sampleTraffic(services: ServiceDTO[]): Promise<boolean> {
		const text = await DockerService.traefikMetrics();
		if (!text) {
			this.#lastTraffic = null;
			this.#trafficSince = null;
			return false;
		}
		const idBySlug = new Map(services.map((svc) => [svc.slug, svc.id]));
		const current = countersBySlug(
			parseTraefikMetrics(text),
			new Set(idBySlug.keys()),
		);
		const previous = this.#lastTraffic;
		this.#lastTraffic = current;
		if (!previous) {
			this.#trafficSince = new Date();
			return false;
		}
		await TrafficSampleDTO.recordMany(
			[...current].flatMap(([slug, counters]) => {
				const serviceId = idBySlug.get(slug);
				const before = previous.get(slug);
				return serviceId && before
					? [{ ...counterDelta(before, counters), serviceId }]
					: [];
			}),
		);
		return true;
	}

	/** One service's current sample : its container's, or the sum over its local swarm replicas. Null when nothing of it runs here. */
	async #sampleService(svc: ServiceDTO): Promise<ContainerSample | null> {
		if (svc.containerId) {
			return await DockerService.sampleContainerStats(svc.containerId);
		}
		if (svc.swarmServiceId) {
			const replicas = await DockerService.listSwarmReplicas(
				svc.swarmServiceId,
			);
			return sumReplicaSamples(replicas.map((replica) => replica.sample));
		}
		return null;
	}

	/** Every running workstation's sample, wherever it runs; one that can't be read (still starting, its agent down) is skipped. */
	async #sampleWorkstations(): Promise<NewStatSampleInput[]> {
		const running = await WorkstationDTO.listRunning();
		const samples = await Promise.all(
			running.map((ws) =>
				WorkstationService.stats(ws).then(
					(sample) => ({
						cpuPercent: sample.cpuPercent,
						memLimitMb: sample.memLimitMb,
						memUsedMb: sample.memUsedMb,
						netRxBytes: sample.netRxBytes,
						netTxBytes: sample.netTxBytes,
						serviceId: null,
						workstationId: ws.id,
					}),
					() => null,
				),
			),
		);
		return samples.filter((sample) => sample !== null);
	}

	/**
	 * Samples host stats, every running service's container stats, every
	 * swarm service's local replicas and every running workstation in parallel and writes them as one batch of `stat_sample` rows
	 * (`StatSampleDTO.recordMany`). Every `PRUNE_EVERY_TICKS`th tick also
	 * prunes old samples (`StatSampleDTO.prune`).
	 */
	protected async tick(): Promise<void> {
		this.#ticks += 1;

		const [host, services, workstations] = await Promise.all([
			SystemStatsService.getSystemStats(),
			ServiceDTO.listRunningWithContainers(),
			this.#sampleWorkstations().catch((err: unknown) => {
				this.logger.warn("Couldn't sample the workstations", err);
				return [];
			}),
		]);
		await CapacityService.evaluate(host).catch((err) => {
			this.logger.warn("Couldn't check the resource thresholds", err);
		});

		const samples = await Promise.all(
			services.map(async (svc) => {
				const sample = await this.#sampleService(svc);
				return sample
					? {
							cpuPercent: sample.cpuPercent,
							memLimitMb: sample.memLimitMb,
							memUsedMb: sample.memUsedMb,
							netRxBytes: sample.netRxBytes,
							netTxBytes: sample.netTxBytes,
							serviceId: svc.id,
						}
					: null;
			}),
		);

		await StatSampleDTO.recordMany([
			{
				cpuPercent: host.cpuPercent,
				diskUsedGb: host.diskUsedGb,
				memLimitMb: host.memTotalMb,
				memUsedMb: host.memUsedMb,
				serviceId: null,
			},
			...samples.filter((sample) => sample !== null),
			...workstations,
		]);

		const sampled = await this.#sampleTraffic(services).catch((err) => {
			this.logger.warn("Couldn't record request traffic", err);
			return false;
		});
		if (sampled && this.#trafficSince) {
			await ScaleToZeroService.sleepIdle(new Date(), this.#trafficSince).catch(
				(err) => {
					this.logger.warn("Couldn't put idle services to sleep", err);
				},
			);
		}

		if (this.#ticks % PRUNE_EVERY_TICKS === 0) {
			await StatSampleDTO.prune();
			await TrafficSampleDTO.prune();
		}
	}
}
