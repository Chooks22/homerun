import { config } from "#lib/config.js";
import {
	type KnownRun,
	PipelineRunDTO,
	type PipelineStats,
} from "#lib/dto/pipeline-run-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
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
	type PipelineProvider,
	type PipelineRateRule,
} from "#lib/pipelines/types.js";
import { pipelineSpanToken } from "#lib/tracing/ingest-token.js";
import { StatusCheckService } from "./status-check.service.ts";
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

export interface PipelineOverview {
	allTime: PipelineStats;
	provider: PipelineProvider | null;
	providerError: string | null;
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

/**
 * CI pipelines: reads a git-built service's GitHub Actions, GitLab CI or
 * Gitea Actions runs through the provider API with its owner's connection,
 * stores each run with its jobs, timings and cost, and exports finished runs
 * as traces through the OpenTelemetry collector.
 */
class PipelineServiceClass {
	/**
	 * A CI client for the service's repo.
	 *
	 * @throws When the service isn't built from git, its provider can't be
	 * resolved, or it's one without a CI API Homerun reads (Bitbucket).
	 */
	async clientFor(svc: ServiceDTO): Promise<PipelineClient> {
		if (!(svc.buildSource === "git" && svc.gitUrl)) {
			throw new Error("Only services built from a git repo have pipelines.");
		}
		const target = await StatusCheckService.targetFor(svc.gitUrl, svc.userId);
		const { kind } = target;
		if (!isPipelineProvider(kind)) {
			throw new Error(
				"Homerun reads GitHub Actions, GitLab CI and Gitea Actions; Bitbucket Pipelines isn't supported.",
			);
		}
		return new PipelineClient({ ...target, kind });
	}

	/** The rate rules that apply to a service: its own, else the defaults for its provider. */
	rates(
		svc: ServiceDTO,
		provider: PipelineProvider | null,
	): PipelineRateRule[] {
		return svc.toJSON().pipelineRates ?? defaultRates(provider);
	}

	/**
	 * Reads the latest runs, fetches the jobs of every run that's new,
	 * unfinished or re-run since the last sync, stores them, then exports
	 * each finished run not exported yet as a trace. Records when it synced
	 * and why it failed on the service.
	 *
	 * @throws When the provider can't be resolved or refuses a call.
	 */
	async sync(svc: ServiceDTO): Promise<SyncResult> {
		try {
			const result = await this.#sync(svc);
			await svc.update({
				pipelinesError: null,
				pipelinesSyncedAt: new Date(),
			});
			return result;
		} catch (err) {
			await svc.update({
				pipelinesError: err instanceof Error ? err.message : String(err),
				pipelinesSyncedAt: new Date(),
			});
			throw err;
		}
	}

	/** The sync itself, see `sync`. */
	async #sync(svc: ServiceDTO): Promise<SyncResult> {
		const client = await this.clientFor(svc);
		const rules = this.rates(svc, client.provider);
		const runs = await client.listRuns(RUNS_PER_SYNC);
		const known = await PipelineRunDTO.known(
			svc.id,
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
				serviceId: svc.id,
				traceId: null,
			});
			updated += 1;
		}
		const exported = await this.#exportTraces(svc.id);
		if (updated > 0 || exported > 0) {
			logger.info(
				`Synced pipelines: service=${svc.id} fetched=${runs.length} updated=${updated} exported=${exported}`,
			);
		}
		return { exported, fetched: runs.length, updated };
	}

	/** Exports every finished run of a service whose trace hasn't gone out yet. */
	async #exportTraces(serviceId: string): Promise<number> {
		let exported = 0;
		for (const dto of await PipelineRunDTO.listUnexported(serviceId)) {
			const run = dto.toJSON();
			const body = buildPipelineTrace({
				...run,
				pipelineToken: pipelineSpanToken(config.auth.secret, serviceId),
				serviceId,
			});
			if (!body) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- one run's spans per export keeps each request small
			await TracingService.exportSpans(body);
			// oxlint-disable-next-line no-await-in-loop -- marked right after its own export
			await dto.markExported(pipelineTraceId({ ...run, serviceId }));
			exported += 1;
		}
		return exported;
	}

	/**
	 * Saves whether the service syncs its CI runs and its runner rates, then
	 * re-costs every stored run at the new rates. Blank rates go back to the
	 * provider's defaults.
	 *
	 * @throws When a rate line doesn't parse.
	 */
	async saveSettings(
		svc: ServiceDTO,
		input: { enabled: boolean; rates: string },
	): Promise<void> {
		const rules = input.rates.trim() ? parseRates(input.rates) : null;
		await svc.update({
			pipelineRates: rules,
			pipelinesEnabled: input.enabled,
			...(input.enabled ? {} : { pipelinesError: null }),
		});
		const provider = await this.#provider(svc);
		const effective = this.rates(svc, provider);
		for (const dto of await PipelineRunDTO.listForService(svc.id)) {
			const { costUsd, jobs } = recostJobs(dto.toJSON().jobs, effective);
			// oxlint-disable-next-line no-await-in-loop -- one small update per run
			await dto.setCost(costUsd, jobs);
		}
		logger.info(
			`Pipeline settings saved: service=${svc.id} enabled=${input.enabled} rates=${rules ? rules.length : "default"}`,
		);
	}

	/** The provider of the service's repo, or null when it can't be resolved. */
	async #provider(svc: ServiceDTO): Promise<PipelineProvider | null> {
		try {
			return (await this.clientFor(svc)).provider;
		} catch {
			return null;
		}
	}

	/** What the Pipelines tab shows above the runs: totals over the last 30 days and all time, per workflow, and the rates in force. */
	async overview(svc: ServiceDTO, now = new Date()): Promise<PipelineOverview> {
		const since = new Date(now.getTime() - STATS_WINDOW_DAYS * DAY_MS);
		const [client, window, allTime, workflows] = await Promise.all([
			this.clientFor(svc).then(
				(value) => ({ error: null, value }),
				(err: unknown) => ({
					error: err instanceof Error ? err.message : String(err),
					value: null,
				}),
			),
			PipelineRunDTO.stats(svc.id, since),
			PipelineRunDTO.stats(svc.id, null),
			PipelineRunDTO.byWorkflow(svc.id, since),
		]);
		const provider = client.value?.provider ?? null;
		return {
			allTime,
			provider,
			providerError: client.error,
			rates: this.rates(svc, provider),
			ratesCustom: svc.toJSON().pipelineRates !== null,
			window,
			workflows,
		};
	}
}

export const PipelineService = new PipelineServiceClass();
