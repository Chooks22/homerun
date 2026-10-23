export type StatusCheckProviderKind =
	| "github"
	| "gitlab"
	| "gitea"
	| "bitbucket";

export type CheckState = "pending" | "success" | "failure";

export interface CheckResult {
	detail: string | null;
	name: string;
	state: CheckState;
}

export interface CheckEvaluation {
	failed: string[];
	missing: string[];
	outcome: "pass" | "pending" | "fail";
	passed: string[];
	pending: string[];
}

export interface CheckTarget {
	api: string;
	kind: StatusCheckProviderKind;
	repo: string;
	token: string | null;
}

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

const WELL_KNOWN_HOSTS: Record<string, StatusCheckProviderKind> = {
	"bitbucket.org": "bitbucket",
	"github.com": "github",
	"gitlab.com": "gitlab",
};

const STATE_RANK: Record<CheckState, number> = {
	failure: 2,
	pending: 1,
	success: 0,
};

export class StatusCheckApiError extends Error {
	override name = "StatusCheckApiError";
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}

	/**
	 * Whether retrying can't help (bad credentials, no access, unknown repo or ref),
	 * so polling should stop rather than try again.
	 */
	get permanent(): boolean {
		return [401, 403, 404, 422].includes(this.status);
	}
}

/**
 * Infers the provider kind from a git URL's host, for the public GitHub, GitLab
 * and Bitbucket hosts only; self-hosted instances yield null.
 */
export function inferProviderKind(
	gitUrl: string,
): StatusCheckProviderKind | null {
	const host = parseGitUrl(gitUrl)?.host;
	return host ? (WELL_KNOWN_HOSTS[host] ?? null) : null;
}

function parseGitUrl(gitUrl: string): { host: string; path: string } | null {
	const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(gitUrl.trim());
	if (scp) {
		return { host: scp[1].toLowerCase(), path: `/${scp[2]}` };
	}
	try {
		const url = new URL(gitUrl.trim());
		return { host: url.host.toLowerCase(), path: url.pathname };
	} catch {
		return null;
	}
}

/**
 * Extracts the `owner/repo` (or GitLab `group/subgroup/repo`) path from an HTTPS
 * or scp-style git URL, stripping `.git`, any `/-/...` suffix and a self-hosted
 * instance's base path.
 *
 * @param baseUrl The provider's base URL, whose path is removed when the
 * instance is served under a subpath.
 * @returns null when the URL can't be parsed or has no owner segment.
 */
export function repoPathFromGitUrl(
	gitUrl: string,
	baseUrl: string | null = null,
): string | null {
	const parsed = parseGitUrl(gitUrl);
	if (!parsed) {
		return null;
	}
	let path = decodeURIComponent(parsed.path);
	const basePath = baseUrl ? parseGitUrl(baseUrl)?.path : null;
	const prefix = basePath?.replace(/\/+$/, "");
	if (prefix && path.startsWith(`${prefix}/`)) {
		path = path.slice(prefix.length);
	}
	const repo = path
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "")
		.replace(/\/-\/.*$/, "");
	return repo.includes("/") ? repo : null;
}

/**
 * The REST API root for a provider, accounting for GitHub Enterprise and
 * self-hosted GitLab base URLs.
 *
 * @throws For a Gitea provider without a base URL.
 */
export function providerApiBase(
	kind: StatusCheckProviderKind,
	baseUrl: string | null,
): string {
	const base = baseUrl?.replace(/\/+$/, "") || null;
	switch (kind) {
		case "github":
			return base && !base.endsWith("github.com")
				? `${base}/api/v3`
				: "https://api.github.com";
		case "gitlab":
			return `${base ?? "https://gitlab.com"}/api/v4`;
		case "gitea":
			if (!base) {
				throw new Error("Gitea providers require a base URL.");
			}
			return `${base}/api/v1`;
		case "bitbucket":
			return "https://api.bitbucket.org/2.0";
		default: {
			const exhaustive: never = kind;
			throw new Error(`Unknown git provider kind: ${exhaustive}`);
		}
	}
}

interface GitHubCheckRun {
	conclusion: string | null;
	name: string;
	output?: { title?: string | null } | null;
	status: string;
}

interface GitHubStatus {
	context: string;
	description?: string | null;
	state: string;
}

interface GitLabStatus {
	allow_failure?: boolean;
	description?: string | null;
	name: string;
	status: string;
}

interface GitLabPipeline {
	status: string;
}

interface GiteaStatus {
	context: string;
	description?: string | null;
	state?: string;
	status?: string;
}

interface BitbucketStatus {
	description?: string | null;
	key: string;
	state: string;
}

const GITHUB_PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * Maps a GitHub check-runs response to check results; anything not completed is
 * pending, and neutral or skipped conclusions count as success.
 */
export function mapGitHubCheckRuns(body: unknown): CheckResult[] {
	const runs = (body as { check_runs?: GitHubCheckRun[] } | null)?.check_runs;
	return (runs ?? []).map((run) => {
		let state: CheckState = "failure";
		if (run.status !== "completed") {
			state = "pending";
		} else if (GITHUB_PASSING.has(run.conclusion ?? "")) {
			state = "success";
		}
		return {
			detail: run.status === "completed" ? run.conclusion : run.status,
			name: run.name,
			state,
		};
	});
}

/**
 * Maps a GitHub combined commit status response to check results, one per status
 * context.
 */
export function mapGitHubStatuses(body: unknown): CheckResult[] {
	const statuses = (body as { statuses?: GitHubStatus[] } | null)?.statuses;
	return (statuses ?? []).map((status) => ({
		detail: status.description ?? status.state,
		name: status.context,
		state: stateFrom(status.state, {
			failure: ["failure", "error"],
			success: ["success"],
		}),
	}));
}

function stateFrom(
	value: string,
	groups: { failure: string[]; success: string[] },
): CheckState {
	if (groups.success.includes(value)) {
		return "success";
	}
	return groups.failure.includes(value) ? "failure" : "pending";
}

function gitLabJobState(status: GitLabStatus): CheckState {
	if (status.status === "success" || status.status === "skipped") {
		return "success";
	}
	if (status.status === "failed" || status.status === "canceled") {
		return status.allow_failure && status.status === "failed"
			? "success"
			: "failure";
	}
	if (status.status === "manual" && status.allow_failure) {
		return "success";
	}
	return "pending";
}

/**
 * Maps GitLab commit statuses (CI jobs) to check results; skipped jobs and
 * failed or manual jobs that are allowed to fail count as success.
 */
export function mapGitLabStatuses(body: unknown): CheckResult[] {
	const rows = Array.isArray(body) ? (body as GitLabStatus[]) : [];
	return rows.map((status) => ({
		detail: status.description ?? status.status,
		name: status.name,
		state: gitLabJobState(status),
	}));
}

/**
 * Maps GitLab's pipeline list for a commit to a single check named `pipeline`
 * reflecting the latest pipeline, or nothing when there is none.
 */
export function mapGitLabPipelines(body: unknown): CheckResult[] {
	const latest = Array.isArray(body)
		? (body as GitLabPipeline[])[0]
		: undefined;
	if (!latest) {
		return [];
	}
	return [
		{
			detail: latest.status,
			name: "pipeline",
			state: stateFrom(latest.status, {
				failure: ["failed", "canceled"],
				success: ["success", "skipped"],
			}),
		},
	];
}

/**
 * Maps a Gitea combined commit status response to check results; a warning
 * counts as success.
 */
export function mapGiteaStatuses(body: unknown): CheckResult[] {
	const statuses = (body as { statuses?: GiteaStatus[] | null } | null)
		?.statuses;
	return (statuses ?? []).map((status) => {
		const value = status.status ?? status.state ?? "pending";
		return {
			detail: status.description || value,
			name: status.context,
			state: stateFrom(value, {
				failure: ["failure", "error"],
				success: ["success", "warning"],
			}),
		};
	});
}

/**
 * Maps Bitbucket commit build statuses to check results, one per status key;
 * stopped builds count as failures.
 */
export function mapBitbucketStatuses(body: unknown): CheckResult[] {
	const values = (body as { values?: BitbucketStatus[] } | null)?.values;
	return (values ?? []).map((status) => ({
		detail: status.description || status.state,
		name: status.key,
		state: stateFrom(status.state, {
			failure: ["FAILED", "STOPPED"],
			success: ["SUCCESSFUL"],
		}),
	}));
}

/**
 * De-duplicates checks by name, keeping the worst state reported for each
 * (failure over pending over success).
 */
export function mergeChecks(results: CheckResult[]): CheckResult[] {
	const byName = new Map<string, CheckResult>();
	for (const result of results) {
		const existing = byName.get(result.name);
		if (!existing || STATE_RANK[result.state] > STATE_RANK[existing.state]) {
			byName.set(result.name, result);
		}
	}
	return [...byName.values()];
}

/**
 * Classifies each required check as passed, failed, pending or missing and
 * derives the overall outcome.
 *
 * @param graceExpired Whether the grace period for checks to appear is over; a
 * missing check only fails the evaluation once it is and nothing else is still
 * running.
 */
export function evaluateChecks(
	required: string[],
	results: CheckResult[],
	graceExpired: boolean,
): CheckEvaluation {
	const byName = new Map(mergeChecks(results).map((r) => [r.name, r]));
	const evaluation: CheckEvaluation = {
		failed: [],
		missing: [],
		outcome: "pass",
		passed: [],
		pending: [],
	};
	for (const name of required) {
		const state = byName.get(name)?.state;
		if (state === "success") {
			evaluation.passed.push(name);
		} else if (state === "failure") {
			evaluation.failed.push(name);
		} else if (state === "pending") {
			evaluation.pending.push(name);
		} else {
			evaluation.missing.push(name);
		}
	}
	evaluation.outcome = outcomeOf(evaluation, results, graceExpired);
	return evaluation;
}

/**
 * Derives the overall outcome of an evaluation: any failure fails, anything
 * pending waits, and missing checks keep waiting until the grace period is over
 * and every reported check has finished.
 */
function outcomeOf(
	evaluation: CheckEvaluation,
	results: CheckResult[],
	graceExpired: boolean,
): CheckEvaluation["outcome"] {
	if (evaluation.failed.length > 0) {
		return "fail";
	}
	if (evaluation.pending.length > 0) {
		return "pending";
	}
	if (evaluation.missing.length === 0) {
		return "pass";
	}
	const everythingFinished = results.every((r) => r.state !== "pending");
	return everythingFinished && graceExpired ? "fail" : "pending";
}

/**
 * Summarises an evaluation for the build log, listing failed, never-reported,
 * still-running and passed checks.
 */
export function describeEvaluation(evaluation: CheckEvaluation): string {
	const parts: string[] = [];
	if (evaluation.failed.length > 0) {
		parts.push(`failed: ${evaluation.failed.join(", ")}`);
	}
	if (evaluation.missing.length > 0) {
		parts.push(`never reported: ${evaluation.missing.join(", ")}`);
	}
	if (evaluation.pending.length > 0) {
		parts.push(`still running: ${evaluation.pending.join(", ")}`);
	}
	if (evaluation.passed.length > 0) {
		parts.push(`passed: ${evaluation.passed.join(", ")}`);
	}
	return parts.join("; ");
}

interface CheckSource {
	map: (body: unknown) => CheckResult[];
	path: string;
}

function encodedRepo(target: CheckTarget): string {
	return target.kind === "gitlab"
		? encodeURIComponent(target.repo)
		: target.repo;
}

/**
 * The provider API path listing the latest commits on a branch or ref.
 *
 * @param count How many commits to request.
 */
export function commitsPath(
	target: CheckTarget,
	ref: string,
	count: number,
): string {
	const repo = encodedRepo(target);
	const branch = encodeURIComponent(ref);
	switch (target.kind) {
		case "github":
			return `/repos/${repo}/commits?sha=${branch}&per_page=${count}`;
		case "gitlab":
			return `/projects/${repo}/repository/commits?ref_name=${branch}&per_page=${count}`;
		case "gitea":
			return `/repos/${repo}/commits?sha=${branch}&limit=${count}&stat=false&verification=false&files=false`;
		case "bitbucket":
			return `/repositories/${repo}/commits/${branch}?pagelen=${count}`;
		default: {
			const exhaustive: never = target.kind;
			throw new Error(`Unknown git provider kind: ${exhaustive}`);
		}
	}
}

/** Extracts commit SHAs, newest first, from a provider's commit list response. */
export function shasFromCommits(
	kind: StatusCheckProviderKind,
	body: unknown,
): string[] {
	if (kind === "bitbucket") {
		const values = (body as { values?: Array<{ hash?: string }> } | null)
			?.values;
		return (values ?? []).flatMap((commit) =>
			commit.hash ? [commit.hash] : [],
		);
	}
	const rows = Array.isArray(body)
		? (body as Array<{ id?: string; sha?: string }>)
		: [];
	return rows.flatMap((commit) => {
		const sha = kind === "gitlab" ? commit.id : commit.sha;
		return sha ? [sha] : [];
	});
}

/**
 * The API endpoints to read a commit's checks from on a provider, each with the
 * mapper for its response: check runs and statuses on GitHub, job statuses and
 * pipelines on GitLab, and commit statuses on Gitea and Bitbucket.
 */
export function checkSources(target: CheckTarget, sha: string): CheckSource[] {
	const repo = encodedRepo(target);
	switch (target.kind) {
		case "github":
			return [
				{
					map: mapGitHubCheckRuns,
					path: `/repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
				},
				{
					map: mapGitHubStatuses,
					path: `/repos/${repo}/commits/${sha}/status?per_page=100`,
				},
			];
		case "gitlab":
			return [
				{
					map: mapGitLabStatuses,
					path: `/projects/${repo}/repository/commits/${sha}/statuses?all=false&per_page=100`,
				},
				{
					map: mapGitLabPipelines,
					path: `/projects/${repo}/pipelines?sha=${sha}&per_page=1`,
				},
			];
		case "gitea":
			return [
				{
					map: mapGiteaStatuses,
					path: `/repos/${repo}/commits/${sha}/status`,
				},
			];
		case "bitbucket":
			return [
				{
					map: mapBitbucketStatuses,
					path: `/repositories/${repo}/commit/${sha}/statuses?pagelen=100`,
				},
			];
		default: {
			const exhaustive: never = target.kind;
			throw new Error(`Unknown git provider kind: ${exhaustive}`);
		}
	}
}

/**
 * Request headers for a provider API call, with GitHub's JSON media type and a
 * bearer token when the target has one.
 */
export function authHeaders(target: CheckTarget): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (target.kind === "github") {
		headers.Accept = "application/vnd.github+json";
	}
	if (target.token) {
		headers.Authorization = `Bearer ${target.token}`;
	}
	return headers;
}

export class StatusCheckClient {
	readonly #fetch: FetchLike;
	readonly #target: CheckTarget;

	constructor(target: CheckTarget, fetchImpl: FetchLike = fetch) {
		this.#target = target;
		this.#fetch = fetchImpl;
	}

	/**
	 * GETs a path on the provider API with a 15s timeout and parses the JSON body.
	 *
	 * @throws StatusCheckApiError On a non-2xx response, carrying the status code.
	 */
	async #get(path: string): Promise<unknown> {
		const response = await this.#fetch(`${this.#target.api}${path}`, {
			headers: authHeaders(this.#target),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new StatusCheckApiError(
				`${this.#target.kind} API returned HTTP ${response.status} for ${this.#target.repo}${body ? `: ${body.trim().slice(0, 160)}` : ""}`,
				response.status,
			);
		}
		return await response.json();
	}

	/** Lists the SHAs of the latest commits on a ref, newest first. */
	async recentCommits(ref: string, count: number): Promise<string[]> {
		return shasFromCommits(
			this.#target.kind,
			await this.#get(commitsPath(this.#target, ref, count)),
		);
	}

	/**
	 * Resolves a branch or ref to the SHA of its head commit.
	 *
	 * @throws StatusCheckApiError With a 404 status when the ref has no commits.
	 */
	async resolveCommit(ref: string): Promise<string> {
		const [sha] = await this.recentCommits(ref, 1);
		if (!sha) {
			throw new StatusCheckApiError(
				`No commit found for ${this.#target.repo}@${ref}.`,
				404,
			);
		}
		return sha;
	}

	/**
	 * Fetches every check reported on a commit from all of the provider's sources,
	 * merged by name.
	 */
	async checks(sha: string): Promise<CheckResult[]> {
		const sources = checkSources(this.#target, sha);
		const lists = await Promise.all(
			sources.map(async (source) => source.map(await this.#get(source.path))),
		);
		return mergeChecks(lists.flat());
	}

	/**
	 * Lists the distinct check names reported on the latest commits of a ref, sorted,
	 * so the UI can offer them when picking required checks.
	 *
	 * @param commits How many recent commits to sample.
	 */
	async checkNames(ref: string, commits = 5): Promise<string[]> {
		const shas = await this.recentCommits(ref, commits);
		const lists = await Promise.all(shas.map((sha) => this.checks(sha)));
		return [...new Set(lists.flat().map((check) => check.name))].sort((a, b) =>
			a.localeCompare(b),
		);
	}
}

export type CheckRound =
	| {
			evaluation: CheckEvaluation;
			outcome: "pass" | "fail" | "pending" | "timeout";
	  }
	| { outcome: "retry"; reason: string };

export interface CheckRoundOptions {
	fetchChecks: () => Promise<CheckResult[]>;
	graceMs: number;
	required: string[];
	timeoutMs: number;
	waitedMs: number;
}

function emptyEvaluation(required: string[]): CheckEvaluation {
	return {
		failed: [],
		missing: [...required],
		outcome: "pending",
		passed: [],
		pending: [],
	};
}

/**
 * Fetches and evaluates a commit's checks once, `waitedMs` into the wait for
 * them: passed, failed (a check that never reported fails once the grace
 * period is over), still pending, timed out, or "retry" when the provider
 * API failed transiently and the wait isn't over yet.
 *
 * @throws StatusCheckApiError When the provider API fails permanently.
 */
export async function checkRound(
	options: CheckRoundOptions,
): Promise<CheckRound> {
	const timedOut = options.waitedMs >= options.timeoutMs;
	let results: CheckResult[];
	try {
		results = await options.fetchChecks();
	} catch (err) {
		if (err instanceof StatusCheckApiError && err.permanent) {
			throw err;
		}
		if (timedOut) {
			return {
				evaluation: emptyEvaluation(options.required),
				outcome: "timeout",
			};
		}
		return {
			outcome: "retry",
			reason: err instanceof Error ? err.message : String(err),
		};
	}
	const evaluation = evaluateChecks(
		options.required,
		results,
		options.waitedMs >= options.graceMs,
	);
	if (evaluation.outcome === "pending" && timedOut) {
		return { evaluation, outcome: "timeout" };
	}
	return { evaluation, outcome: evaluation.outcome };
}
