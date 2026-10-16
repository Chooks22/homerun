import { ServiceGitDTO } from "#lib/dto/service-git-dto.js";
import { PipelineService } from "../pipeline.service.ts";
import { BaseScheduler } from "./base-scheduler.ts";

const TICK_MS = 5 * 60 * 1000;

/**
 * Every five minutes, syncs the CI runs of each git service with pipelines
 * turned on, one service after another; a failure is recorded on the
 * service for its Pipelines tab and doesn't stop the others.
 */
export class PipelineSyncScheduler extends BaseScheduler {
	protected readonly label = "PipelineSync";

	protected readonly intervalMs = TICK_MS;

	protected readonly runOnStart = true;

	/** Syncs every service with pipelines on, sequentially so one token never runs two syncs at once. */
	protected async tick(): Promise<void> {
		const services = await ServiceGitDTO.listPipelinesEnabled();
		for (const svc of services) {
			// oxlint-disable-next-line no-await-in-loop -- sequential on purpose, provider APIs rate-limit per token
			await PipelineService.sync(svc).catch((err) => {
				this.logger.warn(
					`Couldn't sync pipelines: service=${svc.id} : ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	}
}
