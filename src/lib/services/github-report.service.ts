import { config, serviceDomain } from "#lib/config.js";
import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { deployEnvironment } from "#lib/release-channels.js";
import type { GitProviderConfig } from "#lib/server/db/schema.js";
import { primaryHostname, serviceHostnames } from "#lib/service-domains.js";
import {
	enabledGitProvider,
	GitProviderService,
} from "./git-provider.service.ts";

const logger = new Logger("GitHubReport");

interface ReportTarget {
	connection: GitConnectionDTO;
	provider: GitProviderConfig;
	repo: string;
}

export const PREVIEW_COMMENT_MARKER = "<!-- homerun-preview -->";

/** The comment a preview's pull request gets for a deploy's outcome: its URLs and commit on success, a pointer to the log either way. */
export function previewCommentBody(outcome: {
	commit: string | null;
	logUrl: string | null;
	ok: boolean;
	urls: string[];
}): string {
	const commit = outcome.commit
		? ` from \`${outcome.commit.slice(0, 7)}\``
		: "";
	const lines = [
		outcome.ok
			? `✅ **Preview deployed**${commit}.`
			: `❌ **Preview failed to deploy**${commit}.`,
	];
	if (outcome.ok && outcome.urls.length > 0) {
		lines.push("", ...outcome.urls.map((url) => `- ${url}`));
	}
	if (outcome.logUrl) {
		lines.push("", `[Deployment log](${outcome.logUrl})`);
	}
	return lines.join("\n");
}

/**
 * Reports deploys back to GitHub when the service (a preview's or canary's
 * parent, for those) has `previewReportGithub` on and its repo was picked
 * from a connected GitHub provider. Every deploy becomes a GitHub deployment
 * with its outcome: a pull request preview to a transient environment named
 * after its slug, plus a comment on the pull request with its URLs, updated
 * in place and deactivated with the preview; the service itself and its
 * canary or other environments to the environment they deploy as
 * (`deployEnvironment`: production, canary, staging...). Calls go out as the
 * root service's owner. Everything here is fire-and-forget: a failure is
 * logged, never thrown into a deploy.
 */
class GitHubReportServiceClass {
	/** Reports a finished deploy of `svc` to GitHub. Does nothing when its root service doesn't report. */
	deployed(svc: ServiceDTO, deployment: DeploymentDTO, ok: boolean): void {
		this.#deployed(svc, deployment, ok).catch((err) => {
			logger.warn(
				`Couldn't report the deploy to GitHub: service=${svc.id}`,
				err,
			);
		});
	}

	/** Deactivates and deletes the GitHub environment of a removed environment of `parent` (staging, demo...). */
	environmentRemoved(parent: ServiceDTO, environmentName: string): void {
		this.#target(parent)
			.then((target) =>
				target ? this.#closeEnvironment(target, environmentName) : undefined,
			)
			.catch((err) => {
				logger.warn(
					`Couldn't report the environment removal to GitHub: service=${parent.id} environment=${environmentName}`,
					err,
				);
			});
	}

	/** Marks a removed preview's pull request comment and GitHub environment as gone. */
	closed(parent: ServiceDTO, preview: ServiceDTO): void {
		this.#closed(parent, preview).catch((err) => {
			logger.warn(
				`Couldn't report the preview removal to GitHub: service=${preview.id}`,
				err,
			);
		});
	}

	/** Posts the deployment (and, for a preview, the pull request comment) for one finished deploy. */
	async #deployed(
		svc: ServiceDTO,
		deployment: DeploymentDTO,
		ok: boolean,
	): Promise<void> {
		const row = svc.toJSON();
		const root = row.previewParentId
			? await ServiceDTO.get(row.previewParentId)
			: svc;
		const target = root ? await this.#target(root) : null;
		if (!target) {
			return;
		}
		const stack = row.stackId ? await StackDTO.get(row.stackId) : null;
		const scheme = config.traefik.entrypoint === "web" ? "http" : "https";
		const urls = row.dnsResolvable
			? serviceHostnames(row, stack?.slug, serviceDomain()).map(
					(hostname) => `${scheme}://${hostname}`,
				)
			: [];
		const primary = row.dnsResolvable
			? primaryHostname(row, stack?.slug, serviceDomain())
			: null;
		const commit = deployment.toJSON().gitCommit ?? null;
		const logUrl = config.auth.origin
			? `${config.auth.origin.replace(/\/+$/, "")}/services/${svc.id}/environments/revisions/${deployment.id}`
			: null;
		const pr = row.previewPrNumber;
		const environment = pr ? svc.slug : deployEnvironment(row);
		if (pr) {
			await this.#comment(
				target,
				pr,
				previewCommentBody({ commit, logUrl, ok, urls }),
			);
		}
		await this.#deployment(target, {
			description: `Homerun ${pr ? "preview" : environment}${ok ? "" : " failed to deploy"}`,
			environment,
			logUrl,
			production: !pr && environment === "production",
			ref: commit ?? svc.gitRef ?? row.previewBranch ?? "HEAD",
			state: ok ? "success" : "failure",
			transient: Boolean(pr),
			url: primary ? `${scheme}://${primary}` : null,
		});
		logger.info(
			`Reported deploy to GitHub: service=${svc.id} environment=${environment} ok=${ok}`,
		);
	}

	/** Rewrites the comment to say the preview is gone and closes its environment. */
	async #closed(parent: ServiceDTO, preview: ServiceDTO): Promise<void> {
		const pr = preview.toJSON().previewPrNumber;
		const target = pr ? await this.#target(parent) : null;
		if (!(target && pr)) {
			return;
		}
		await this.#comment(target, pr, "Preview removed.");
		await this.#closeEnvironment(target, preview.slug);
	}

	/** Calls GitHub's REST API as the target's connection. */
	async #github(
		target: ReportTarget,
		path: string,
		init: { body?: Record<string, unknown>; method?: string } = {},
	): Promise<Response> {
		return await GitProviderService.api(
			target.provider,
			target.connection,
			`/repos/${target.repo}${path}`,
			init,
		);
	}

	/** Edits Homerun's comment on pull request `pr` (the one carrying `PREVIEW_COMMENT_MARKER` among its first 100), or posts it. */
	async #comment(
		target: ReportTarget,
		pr: number,
		text: string,
	): Promise<void> {
		const res = await this.#github(
			target,
			`/issues/${pr}/comments?per_page=100`,
		);
		const existing = (
			(await res.json()) as Array<{ body?: string; id: number }>
		).find((entry) => entry.body?.includes(PREVIEW_COMMENT_MARKER));
		const body = { body: `${PREVIEW_COMMENT_MARKER}\n${text}` };
		if (existing) {
			await this.#github(target, `/issues/comments/${existing.id}`, {
				body,
				method: "PATCH",
			});
			return;
		}
		await this.#github(target, `/issues/${pr}/comments`, {
			body,
			method: "POST",
		});
	}

	/**
	 * Creates a deployment of `deployment.ref` to `deployment.environment`
	 * (transient for a preview, flagged as production for production) and sets
	 * its outcome as its status. No required contexts, so pending checks on the
	 * commit don't refuse it.
	 *
	 * @throws When GitHub refuses either call or answers without a deployment id.
	 */
	async #deployment(
		target: ReportTarget,
		deployment: {
			description: string;
			environment: string;
			logUrl: string | null;
			production: boolean;
			ref: string;
			state: "failure" | "success";
			transient: boolean;
			url: string | null;
		},
	): Promise<void> {
		const { description, environment } = deployment;
		const created = (await (
			await this.#github(target, "/deployments", {
				body: {
					auto_merge: false,
					description,
					environment,
					production_environment: deployment.production,
					ref: deployment.ref,
					required_contexts: [],
					transient_environment: deployment.transient,
				},
				method: "POST",
			})
		).json()) as { id?: number; message?: string };
		if (!created.id) {
			throw new Error(
				`GitHub didn't create the deployment: ${created.message ?? "no id in its answer"}`,
			);
		}
		await this.#github(target, `/deployments/${created.id}/statuses`, {
			body: {
				description,
				...(deployment.url ? { environment_url: deployment.url } : {}),
				...(deployment.logUrl ? { log_url: deployment.logUrl } : {}),
				state: deployment.state,
			},
			method: "POST",
		});
	}

	/**
	 * Marks every deployment to `environment` inactive, then deletes the
	 * environment. Deleting needs admin rights on the repo, so a refusal there
	 * is only logged: the deployments are already inactive.
	 */
	async #closeEnvironment(
		target: ReportTarget,
		environment: string,
	): Promise<void> {
		const name = encodeURIComponent(environment);
		const deployments = (await (
			await this.#github(
				target,
				`/deployments?environment=${name}&per_page=100`,
			)
		).json()) as Array<{ id: number }>;
		await Promise.all(
			deployments.map((entry) =>
				this.#github(target, `/deployments/${entry.id}/statuses`, {
					body: { state: "inactive" },
					method: "POST",
				}),
			),
		);
		try {
			await this.#github(target, `/environments/${name}`, { method: "DELETE" });
		} catch (err) {
			logger.info(
				`Deactivated the GitHub environment ${environment} but couldn't delete it (needs admin on the repo): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** The GitHub repo and credentials to report `root`'s deploys with, null when reporting is off or impossible. */
	async #target(root: ServiceDTO): Promise<ReportTarget | null> {
		if (!(root.toJSON().previewReportGithub && root.gitRepo)) {
			return null;
		}
		const provider = await enabledGitProvider(root.gitProviderId);
		if (provider?.kind !== "github") {
			return null;
		}
		const connection = await GitConnectionDTO.getForUserAndProvider(
			root.userId,
			provider.id,
		);
		if (!connection) {
			logger.warn(
				`Can't report to GitHub, the owner isn't connected to ${provider.name}: service=${root.id}`,
			);
			return null;
		}
		return { connection, provider, repo: root.gitRepo };
	}
}

export const GitHubReportService = new GitHubReportServiceClass();
