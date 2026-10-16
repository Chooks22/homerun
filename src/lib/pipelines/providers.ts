import {
	authHeaders,
	type CheckTarget,
	type FetchLike,
	StatusCheckApiError,
} from "#lib/status-checks.js";
import {
	type FetchedJob,
	type FetchedRun,
	normalizeStatus,
	type PipelineProvider,
	type PipelineStep,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function urlOf(value: unknown): string | null {
	const text = textOf(value);
	return text && /^https?:\/\//i.test(text) ? text : null;
}

function idOf(value: unknown): string | null {
	return typeof value === "number" || (typeof value === "string" && value)
		? String(value)
		: null;
}

function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timeOf(value: unknown): string | null {
	const text = textOf(value);
	if (!text || text.startsWith("0001-")) {
		return null;
	}
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function loginOf(value: unknown): string | null {
	return isRecord(value)
		? (textOf(value.login) ?? textOf(value.username))
		: null;
}

function labelsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((label): label is string => typeof label === "string")
		: [];
}

/** Whether a provider kind has a CI API Homerun reads. */
export function isPipelineProvider(kind: string): kind is PipelineProvider {
	return kind === "github" || kind === "gitlab" || kind === "gitea";
}

/** The `service.name` CI spans carry, which the trace list shows as their service. */
export function pipelineServiceName(provider: PipelineProvider): string {
	switch (provider) {
		case "github":
			return "github-actions";
		case "gitlab":
			return "gitlab-ci";
		case "gitea":
			return "gitea-actions";
		default: {
			const exhaustive: never = provider;
			throw new Error(`Unknown pipeline provider: ${exhaustive}`);
		}
	}
}

/** One GitHub Actions or Gitea Actions workflow run, which share a shape. */
export function mapActionsRun(value: unknown): FetchedRun | null {
	if (!isRecord(value)) {
		return null;
	}
	const externalId = idOf(value.id);
	if (!externalId) {
		return null;
	}
	const path = textOf(value.path)?.split("@")[0] ?? null;
	return {
		actor: loginOf(value.triggering_actor) ?? loginOf(value.actor),
		attempt: numberOf(value.run_attempt) ?? 1,
		branch: textOf(value.head_branch),
		commitSha: textOf(value.head_sha),
		createdAt: timeOf(value.created_at),
		event: textOf(value.event),
		externalId,
		finishedAt: timeOf(value.completed_at),
		name:
			textOf(value.name) ??
			(path ? (path.split("/").pop() ?? path) : null) ??
			"workflow",
		number: numberOf(value.run_number),
		startedAt: timeOf(value.run_started_at) ?? timeOf(value.started_at),
		status: normalizeStatus(value.status, value.conclusion),
		title: textOf(value.display_title),
		url: urlOf(value.html_url),
	};
}

/** The steps of one GitHub Actions or Gitea Actions job. */
function mapActionsSteps(value: unknown): PipelineStep[] {
	return listOf(value).map((step) => ({
		finishedAt: timeOf(step.completed_at),
		name: textOf(step.name) ?? "step",
		startedAt: timeOf(step.started_at),
		status: normalizeStatus(step.status, step.conclusion),
	}));
}

/** One GitHub Actions or Gitea Actions job, with its steps. */
export function mapActionsJob(value: unknown): FetchedJob | null {
	if (!isRecord(value)) {
		return null;
	}
	return {
		attempt: numberOf(value.run_attempt),
		createdAt: timeOf(value.created_at),
		finishedAt: timeOf(value.completed_at),
		labels: labelsOf(value.labels),
		name: textOf(value.name) ?? "job",
		runner: textOf(value.runner_name),
		stage: null,
		startedAt: timeOf(value.started_at),
		status: normalizeStatus(value.status, value.conclusion),
		steps: mapActionsSteps(value.steps),
		url: urlOf(value.html_url),
	};
}

/** One GitLab pipeline from the pipelines list. */
export function mapGitLabPipeline(value: unknown): FetchedRun | null {
	if (!isRecord(value)) {
		return null;
	}
	const externalId = idOf(value.id);
	if (!externalId) {
		return null;
	}
	return {
		actor: loginOf(value.user),
		attempt: 1,
		branch: textOf(value.ref),
		commitSha: textOf(value.sha),
		createdAt: timeOf(value.created_at),
		event: textOf(value.source),
		externalId,
		finishedAt: timeOf(value.finished_at),
		name: textOf(value.name) ?? "pipeline",
		number: numberOf(value.iid),
		startedAt: timeOf(value.started_at),
		status: normalizeStatus(value.status),
		title: null,
		url: urlOf(value.web_url),
	};
}

/** One GitLab job; GitLab reports no steps. */
export function mapGitLabJob(value: unknown): FetchedJob | null {
	if (!isRecord(value)) {
		return null;
	}
	const runner = isRecord(value.runner) ? value.runner : {};
	return {
		attempt: null,
		createdAt: timeOf(value.created_at),
		finishedAt: timeOf(value.finished_at),
		labels: labelsOf(value.tag_list),
		name: textOf(value.name) ?? "job",
		runner: textOf(runner.description),
		stage: textOf(value.stage),
		startedAt: timeOf(value.started_at),
		status: normalizeStatus(value.status),
		steps: [],
		url: urlOf(value.web_url),
	};
}

/** The commit title GitLab only carries on a pipeline's jobs. */
export function gitLabTitle(jobs: unknown): string | null {
	const [first] = listOf(jobs);
	return first && isRecord(first.commit) ? textOf(first.commit.title) : null;
}

/**
 * Reads CI runs and their jobs from a repo's provider API with the same
 * target (API root, repo path, token) status checks use.
 */
export class PipelineClient {
	readonly #fetch: FetchLike;
	readonly #target: CheckTarget & { kind: PipelineProvider };

	constructor(
		target: CheckTarget & { kind: PipelineProvider },
		fetchImpl: FetchLike = fetch,
	) {
		this.#target = target;
		this.#fetch = fetchImpl;
	}

	/** Which provider this client reads. */
	get provider(): PipelineProvider {
		return this.#target.kind;
	}

	/**
	 * GETs a path on the provider API with a 15s timeout and parses the JSON body.
	 *
	 * @throws StatusCheckApiError On a non-2xx response, with a hint when the
	 * provider has no Actions API (an older Gitea).
	 */
	async #get(path: string): Promise<unknown> {
		const response = await this.#fetch(`${this.#target.api}${path}`, {
			headers: authHeaders(this.#target),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const hint =
				this.#target.kind === "gitea" && response.status === 404
					? " Gitea serves its Actions API from 1.24 on."
					: "";
			throw new StatusCheckApiError(
				`${this.#target.kind} API returned HTTP ${response.status} for ${this.#target.repo}${body ? `: ${body.trim().slice(0, 160)}` : ""}.${hint}`,
				response.status,
			);
		}
		return await response.json();
	}

	/** The repo path as the provider's URLs want it. */
	#repo(): string {
		return this.#target.kind === "gitlab"
			? `/projects/${encodeURIComponent(this.#target.repo)}`
			: `/repos/${this.#target.repo}`;
	}

	/** The latest `count` runs (at most 100), newest first. */
	async listRuns(count: number): Promise<FetchedRun[]> {
		const size = Math.min(Math.max(count, 1), 100);
		if (this.#target.kind === "gitlab") {
			const body = await this.#get(
				`${this.#repo()}/pipelines?per_page=${size}&order_by=id&sort=desc`,
			);
			return listOf(body)
				.map(mapGitLabPipeline)
				.filter((run): run is FetchedRun => run !== null);
		}
		const param = this.#target.kind === "gitea" ? "limit" : "per_page";
		const body = await this.#get(
			`${this.#repo()}/actions/runs?${param}=${size}`,
		);
		return listOf(isRecord(body) ? body.workflow_runs : [])
			.map(mapActionsRun)
			.filter((run): run is FetchedRun => run !== null);
	}

	/**
	 * Every job of one run with its steps, plus the commit title when only
	 * the jobs carry it (GitLab).
	 */
	async listJobs(
		run: FetchedRun,
	): Promise<{ jobs: FetchedJob[]; title: string | null }> {
		if (this.#target.kind === "gitlab") {
			const body = await this.#get(
				`${this.#repo()}/pipelines/${run.externalId}/jobs?per_page=100`,
			);
			return {
				jobs: listOf(body)
					.map(mapGitLabJob)
					.filter((job): job is FetchedJob => job !== null),
				title: gitLabTitle(body),
			};
		}
		const param = this.#target.kind === "gitea" ? "limit" : "per_page";
		const body = await this.#get(
			`${this.#repo()}/actions/runs/${run.externalId}/jobs?${param}=100&filter=all`,
		);
		return {
			jobs: listOf(isRecord(body) ? body.jobs : [])
				.map(mapActionsJob)
				.filter((job): job is FetchedJob => job !== null),
			title: null,
		};
	}
}
