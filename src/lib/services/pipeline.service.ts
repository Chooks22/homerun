import { config } from "#lib/config.js";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import {
	type KnownRun,
	PipelineRunDTO,
	type PipelineStats,
} from "#lib/dto/pipeline-run-dto.js";
import { type LinkedService, RepositoryDTO } from "#lib/dto/repository-dto.js";
import { Logger } from "#lib/logger.js";
import { defaultRates, parseRates } from "#lib/pipelines/cost.js";
import { buildPipelineTrace, pipelineTraceId } from "#lib/pipelines/otlp.js";
import {
	isPipelineProvider,
	PipelineClient,
} from "#lib/pipelines/providers.js";
import { recostJobs, summarizeRun } from "#lib/pipelines/summary.js";
import {
	type FetchedRun,
	isFinished,
	type PipelineRateRule,
} from "#lib/pipelines/types.js";
import type { Repository } from "#lib/server/db/schema.js";
import { providerApiBase } from "#lib/status-checks.js";
import { pipelineSpanToken } from "#lib/tracing/ingest-token.js";
import {
	enabledGitProvider,
	GitProviderService,
} from "./git-provider.service.ts";
import { QueueService } from "./queue.service.ts";
import { TracingService } from "./tracing.service.ts";

const logger = new Logger("Pipelines");

const RUNS_PER_SYNC = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export const STATS_WINDOW_DAYS = 30;

export interface SyncResult {
	exported: number;
	fetched: number;
	updated: number;
}

export interface RepositoryPipelines {
	repository: Repository;
	services: LinkedService[];
	stats: PipelineStats | null;
}

export interface GlobalPipelineOverview {
	allTime: PipelineStats;
	repositories: RepositoryPipelines[];
	window: PipelineStats;
}

export interface PipelineOverview {
	allTime: PipelineStats;
	rates: PipelineRateRule[];
	ratesCustom: boolean;
	window: PipelineStats;
	workflows: PipelineStats[];
}

/** Whether a fetched run differs from what's stored, so its jobs need reading again. */
function stale(run: FetchedRun, known: KnownRun | undefined): boolean {
	return !(
		known &&
		isFinished(known.status) &&
		known.attempt === run.attempt &&
		known.status === run.status
	);
}

/** A repository's page on its provider, from the provider's API root. */
function repoWebUrl(api: string, fullName: string): string {
	const web =
		api === "https://api.github.com"
			? "https://github.com"
			: api.replace(/\/api\/v\d+$/, "");
	return `${web}/${fullName}`;
}

/**
 * CI pipelines: watches repositories on connected git providers, reads
 * their GitHub Actions, GitLab CI or Gitea Actions runs with the connection
 * of the user who added them, stores each run with its jobs, timings and
 * cost, and exports finished runs as traces through the OpenTelemetry
 * collector, under the first service linked to the repository.
 */
class PipelineServiceClass {
	/**
	 * A CI client for a watched repository, authenticated as the user who
	 * added it.
	 *
	 * @throws When its provider is gone or disabled, that user isn't
	 * connected to it any more, or it's one without a CI API Homerun reads
	 * (Bitbucket).
	 */
	async clientFor(repo: RepositoryDTO): Promise<PipelineClient> {
		const provider = await enabledGitProvider(repo.providerId);
		if (!provider) {
			throw new Error(
				"The git provider this repository lives on was removed or turned off.",
			);
		}
		const { kind } = provider;
		if (!isPipelineProvider(kind)) {
			throw new Error(
				"Homerun reads GitHub Actions, GitLab CI and Gitea Actions; Bitbucket Pipelines isn't supported.",
			);
		}
		const connection = await GitConnectionDTO.getForUserAndProvider(
			repo.userId,
			provider.id,
		);
		if (!connection) {
			throw new Error(
				`Whoever added this repository isn't connected to ${provider.name} any more.`,
			);
		}
		return new PipelineClient({
			api: providerApiBase(kind, provider.baseUrl),
			kind,
			repo: repo.fullName,
			token: await GitProviderService.accessToken(provider, connection),
		});
	}

	/** The rate rules that apply to a repository: its own, else the defaults for its provider. */
	rates(repo: RepositoryDTO): PipelineRateRule[] {
		const kind = repo.providerKind;
		return (
			repo.toJSON().pipelineRates ??
			defaultRates(isPipelineProvider(kind) ? kind : null)
		);
	}

	/**
	 * Starts watching a repository picked from a provider the user is
	 * connected to, links the services already building from it, and queues
	 * its first sync. Watching one that's already watched returns it as is.
	 *
	 * @throws When the provider is gone or isn't one Homerun reads CI from.
	 */
	async watch(input: {
		defaultBranch: string | null;
		fullName: string;
		providerId: string;
		userId: string;
	}): Promise<RepositoryDTO> {
		const existing = await RepositoryDTO.getByPath(
			input.providerId,
			input.fullName,
		);
		if (existing) {
			return existing;
		}
		const provider = await enabledGitProvider(input.providerId);
		if (!provider) {
			throw new Error("That git provider was removed or turned off.");
		}
		if (!isPipelineProvider(provider.kind)) {
			throw new Error(
				"Homerun reads GitHub Actions, GitLab CI and Gitea Actions; Bitbucket Pipelines isn't supported.",
			);
		}
		const repo = await RepositoryDTO.create({
			defaultBranch: input.defaultBranch,
			fullName: input.fullName,
			providerId: provider.id,
			providerKind: provider.kind,
			userId: input.userId,
			webUrl: repoWebUrl(
				providerApiBase(provider.kind, provider.baseUrl),
				input.fullName,
			),
		});
		await repo.setLinkedServices(
			await RepositoryDTO.servicesBuildingFrom(provider.id, input.fullName),
		);
		await this.enqueueSync(repo, input.userId);
		logger.info(
			`Watching repository=${repo.id} ${provider.kind}:${input.fullName} user=${input.userId}`,
		);
		return repo;
	}

	/**
	 * Queues a sync of one repository's runs as a background job, so a slow
	 * provider never holds a request open. A sync already queued for it is
	 * reused.
	 *
	 * @returns The id of the job that will run it.
	 */
	async enqueueSync(repo: RepositoryDTO, userId: string): Promise<string> {
		const job = await QueueService.enqueue({
			dedupeKey: `pipeline_sync:${repo.id}`,
			lockKey: `pipeline_sync:${repo.id}`,
			maxAttempts: 1,
			payload: { repositoryId: repo.id },
			title: `Sync CI runs of ${repo.fullName}`,
			type: "pipeline_sync",
			userId,
		});
		return job.id;
	}

	/**
	 * Queues a sync of every repository whose runs are synced.
	 *
	 * @returns The ids of the jobs queued.
	 */
	async enqueueSyncAll(userId: string): Promise<string[]> {
		const jobIds: string[] = [];
		for (const repo of await RepositoryDTO.listPipelinesEnabled()) {
			// oxlint-disable-next-line no-await-in-loop -- one insert per repository
			jobIds.push(await this.enqueueSync(repo, userId));
		}
		return jobIds;
	}

	/**
	 * Reads the latest runs, fetches the jobs of every run that's new,
	 * unfinished or re-run since the last sync, stores them, then exports
	 * each finished run not exported yet as a trace. Records when it synced
	 * and why it failed on the repository.
	 *
	 * @param log Receives a line per step, for the job's log.
	 * @throws When the provider can't be resolved or refuses a call.
	 */
	async sync(
		repo: RepositoryDTO,
		log: (line: string) => Promise<void> = async () => {},
	): Promise<SyncResult> {
		try {
			const result = await this.#sync(repo, log);
			await repo.update({
				pipelinesError: null,
				pipelinesSyncedAt: new Date(),
			});
			return result;
		} catch (err) {
			await repo.update({
				pipelinesError: err instanceof Error ? err.message : String(err),
				pipelinesSyncedAt: new Date(),
			});
			throw err;
		}
	}

	/** The sync itself, see `sync`. */
	async #sync(
		repo: RepositoryDTO,
		log: (line: string) => Promise<void>,
	): Promise<SyncResult> {
		const client = await this.clientFor(repo);
		const rules = this.rates(repo);
		const runs = await client.listRuns(RUNS_PER_SYNC);
		await log(`Read ${runs.length} runs of ${repo.fullName}.`);
		const known = await PipelineRunDTO.known(
			repo.id,
			runs.map((run) => run.externalId),
		);
		let updated = 0;
		for (const run of runs) {
			if (!stale(run, known.get(run.externalId))) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- sequential on purpose, provider APIs rate-limit per token
			const jobs = await client.listJobs(run);
			const summary = summarizeRun(run, jobs, rules, new Date());
			// oxlint-disable-next-line no-await-in-loop -- one row per run, right after its jobs were read
			await PipelineRunDTO.upsert({
				...summary,
				externalId: run.externalId,
				provider: client.provider,
				repositoryId: repo.id,
				traceId: null,
			});
			updated += 1;
		}
		await log(`Stored ${updated} new or changed runs.`);
		const exported = await this.#exportTraces(repo);
		await log(`Exported ${exported} finished runs as traces.`);
		if (updated > 0 || exported > 0) {
			logger.info(
				`Synced pipelines: repository=${repo.id} fetched=${runs.length} updated=${updated} exported=${exported}`,
			);
		}
		return { exported, fetched: runs.length, updated };
	}

	/** Exports every finished run of a repository whose trace hasn't gone out yet, under its first linked service, or as Homerun's own when none is linked. */
	async #exportTraces(repo: RepositoryDTO): Promise<number> {
		const [linked] = await repo.linkedServices();
		const serviceId = linked?.id ?? null;
		let exported = 0;
		for (const dto of await PipelineRunDTO.listUnexported(repo.id)) {
			const run = dto.toJSON();
			const body = buildPipelineTrace({
				...run,
				pipelineToken: pipelineSpanToken(config.auth.secret, serviceId ?? ""),
				serviceId,
			});
			if (!body) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- one run's spans per export keeps each request small
			await TracingService.exportSpans(body);
			// oxlint-disable-next-line no-await-in-loop -- marked right after its own export
			await dto.markExported(pipelineTraceId(run), serviceId);
			exported += 1;
		}
		return exported;
	}

	/**
	 * Saves whether the repository's runs are synced, its runner rates and
	 * the services linked to it, then re-costs every stored run at the new
	 * rates. Blank rates go back to the provider's defaults.
	 *
	 * @throws When a rate line doesn't parse.
	 */
	async saveSettings(
		repo: RepositoryDTO,
		input: { enabled: boolean; rates: string; serviceIds: string[] },
	): Promise<void> {
		const rules = input.rates.trim() ? parseRates(input.rates) : null;
		await repo.update({
			pipelineRates: rules,
			pipelinesEnabled: input.enabled,
			...(input.enabled ? {} : { pipelinesError: null }),
		});
		await repo.setLinkedServices(input.serviceIds);
		const effective = this.rates(repo);
		for (const dto of await PipelineRunDTO.listForRepository(repo.id)) {
			const { costUsd, jobs } = recostJobs(dto.toJSON().jobs, effective);
			// oxlint-disable-next-line no-await-in-loop -- one small update per run
			await dto.setCost(costUsd, jobs);
		}
		logger.info(
			`Pipeline settings saved: repository=${repo.id} enabled=${input.enabled} rates=${rules ? rules.length : "default"} services=${input.serviceIds.length}`,
		);
	}

	/** What a repository's page shows above its runs: totals over the last 30 days and all time, per workflow, and the rates in force. */
	async overview(
		repo: RepositoryDTO,
		now = new Date(),
	): Promise<PipelineOverview> {
		const since = new Date(now.getTime() - STATS_WINDOW_DAYS * DAY_MS);
		const [window, allTime, workflows] = await Promise.all([
			PipelineRunDTO.stats(repo.id, since),
			PipelineRunDTO.stats(repo.id, null),
			PipelineRunDTO.byWorkflow(repo.id, since),
		]);
		return {
			allTime,
			rates: this.rates(repo),
			ratesCustom: repo.toJSON().pipelineRates !== null,
			window,
			workflows,
		};
	}

	/**
	 * What the global Pipelines page shows: totals across every watched
	 * repository over the last 30 days and all time, and each repository
	 * with its 30-day totals and linked services, busiest first, then by
	 * name.
	 */
	async globalOverview(now = new Date()): Promise<GlobalPipelineOverview> {
		const since = new Date(now.getTime() - STATS_WINDOW_DAYS * DAY_MS);
		const [window, allTime, perRepository, repositories, linked] =
			await Promise.all([
				PipelineRunDTO.stats(null, since),
				PipelineRunDTO.stats(null, null),
				PipelineRunDTO.byRepository(since),
				RepositoryDTO.list(),
				RepositoryDTO.linkedServicesByRepository(),
			]);
		const rows = repositories.map((repo) => ({
			repository: repo.toJSON(),
			services: linked.get(repo.id) ?? [],
			stats: perRepository.get(repo.id) ?? null,
		}));
		rows.sort(
			(a, b) =>
				(b.stats?.runs ?? 0) - (a.stats?.runs ?? 0) ||
				a.repository.fullName.localeCompare(b.repository.fullName),
		);
		return { allTime, repositories: rows, window };
	}
}

export const PipelineService = new PipelineServiceClass();
