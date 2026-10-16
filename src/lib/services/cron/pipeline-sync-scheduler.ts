import { RepositoryDTO } from "#lib/dto/repository-dto.js";
import { PipelineService } from "../pipeline.service.ts";
import { BaseScheduler } from "./base-scheduler.ts";

const TICK_MS = 5 * 60 * 1000;

/**
 * Every five minutes, syncs the CI runs of each watched repository with
 * syncing on, one after another; a failure is recorded on the repository
 * for its page and doesn't stop the others. A sync asked for by hand goes
 * through the job queue instead (`PipelineService.enqueueSync`).
 */
export class PipelineSyncScheduler extends BaseScheduler {
	protected readonly label = "PipelineSync";

	protected readonly intervalMs = TICK_MS;

	protected readonly runOnStart = true;

	/** Syncs every repository with syncing on, sequentially so one token never runs two syncs at once. */
	protected async tick(): Promise<void> {
		for (const repo of await RepositoryDTO.listPipelinesEnabled()) {
			// oxlint-disable-next-line no-await-in-loop -- sequential on purpose, provider APIs rate-limit per token
			await PipelineService.sync(repo).catch((err) => {
				this.logger.warn(
					`Couldn't sync pipelines: repository=${repo.id} : ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	}
}
