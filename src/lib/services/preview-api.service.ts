import { config, serviceDomain } from "#lib/config.js";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceGitDTO } from "#lib/dto/service-git-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { primaryHostname, serviceHostnames } from "#lib/service-domains.js";
import type { ContainerStatus, RevisionHealth } from "#lib/types.js";
import { DeploymentService } from "./deploy.service.ts";
import { type ImagePreviewInput, PreviewService } from "./preview.service.ts";
import { RevisionService, type RevisionView } from "./revision.service.ts";

const logger = new Logger("Previews");

export interface PreviewRevision {
	deployedAt: Date | null;
	gitCommit: string | null;
	gitRef: string | null;
	health: RevisionHealth | null;
	healthReason: string | null;
	id: string;
	imageDigest: string | null;
	imageRef: string | null;
}

export interface PreviewDeployment {
	createdAt: Date;
	errorMessage: string | null;
	finishedAt: Date | null;
	gitCommit: string | null;
	gitRef: string | null;
	id: string;
	status: ContainerStatus;
}

export interface PreviewView {
	branch: string | null;
	deployment: PreviewDeployment | null;
	gitRef: string | null;
	hostnames: string[];
	id: string;
	name: string;
	prNumber: number;
	revision: PreviewRevision | null;
	slug: string;
	status: ContainerStatus;
	title: string | null;
	url: string | null;
}

export type PromoteResult =
	| {
			deploymentId: string;
			error: null;
			jobId: string;
			preview: PreviewView;
			revision: PreviewRevision;
	  }
	| { error: string; status: number };

export type DeployPreviewResult =
	| { deploymentId: string; error: null; preview: PreviewView }
	| { error: string; status: number };

const PROMOTABLE_HEALTH = new Set<RevisionHealth | null>([null, "healthy"]);

/** The part of a revision a preview's API view shows. */
function revisionOf(view: RevisionView): PreviewRevision {
	return {
		deployedAt: view.lastDeployedAt,
		gitCommit: view.gitCommit,
		gitRef: view.gitRef,
		health: view.health,
		healthReason: view.healthReason,
		id: view.id,
		imageDigest: view.imageDigest,
		imageRef: view.imageRef,
	};
}

/** Whether `given`, a full or abbreviated SHA, names `full`. */
function sameCommit(full: string | null, given: string): boolean {
	return Boolean(full?.toLowerCase().startsWith(given.toLowerCase()));
}

/**
 * Pull request previews as the REST API and CLI see them: each one's current
 * revision and latest deploy attempt, for CI to wait on, and promotion of a
 * preview's exact image to the service it previews.
 */
class PreviewApiServiceClass {
	/** The open previews of `parent`, newest pull request first. */
	async list(parent: ServiceDTO): Promise<PreviewView[]> {
		const previews = await ServiceGitDTO.listPreviews(parent.id);
		const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
		return await Promise.all(
			previews.map((preview) => this.#view(preview, stack?.slug)),
		);
	}

	/** The preview of pull request `prNumber` on `parent`, null when there's none. */
	async get(parent: ServiceDTO, prNumber: number): Promise<PreviewView | null> {
		const preview = await ServiceGitDTO.getPreview(parent.id, prNumber);
		if (!preview) {
			return null;
		}
		const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
		return await this.#view(preview, stack?.slug);
	}

	/**
	 * Deletes the preview of pull request `prNumber` through
	 * `PreviewService.delete`.
	 *
	 * @returns false when there's no such preview.
	 * @throws When the preview's workload can't be removed.
	 */
	async delete(parent: ServiceDTO, prNumber: number): Promise<boolean> {
		const preview = await ServiceGitDTO.getPreview(parent.id, prNumber);
		if (!preview) {
			return false;
		}
		await PreviewService.delete(parent, preview.id);
		return true;
	}

	/**
	 * Creates or updates the preview of pull request `input.prNumber` on an
	 * image-based service from the image CI just pushed at `input.tag`,
	 * through `PreviewService.deployImage`. Refused for a git-built service
	 * (its previews come from the pull request webhook) or a preview, when
	 * previews are off, and when `PreviewService` ignores the request (a
	 * filtered-out branch, a taken slug, no capacity left).
	 */
	async deploy(
		parent: ServiceDTO,
		input: ImagePreviewInput,
	): Promise<DeployPreviewResult> {
		if (parent.buildSource !== "image" || parent.toJSON().previewParentId) {
			return {
				error:
					"Only an image-based service that isn't a preview itself takes previews from CI: a git service's previews come from its pull request webhook.",
				status: 400,
			};
		}
		if (!parent.toJSON().previewsEnabled) {
			return {
				error:
					"Pull request previews are off for this service: turn them on in its Previews tab.",
				status: 409,
			};
		}
		const result = await PreviewService.deployImage(parent, input);
		if (result.status !== "deployed") {
			return {
				error:
					result.status === "ignored"
						? result.reason
						: `The preview of #${input.prNumber} was removed.`,
				status: 409,
			};
		}
		const preview = await this.get(parent, input.prNumber);
		if (!preview) {
			return {
				error: `The preview of #${input.prNumber} disappeared while it was being deployed.`,
				status: 409,
			};
		}
		return { deploymentId: result.deploymentId, error: null, preview };
	}

	/**
	 * Deploys the exact image the preview of pull request `prNumber` runs to
	 * `parent` as a `promote` deploy: it points at the preview's revision
	 * (`rollbackOfDeploymentId`) the way a rollback points at its target, so
	 * nothing is rebuilt, pulled or scanned, yet it's recorded and health-watched
	 * as a fresh revision (auto-rollback applies), and its log opens with where
	 * the image came from. An image-based service ends up on the preview's
	 * image and tag, as `deploy --tag` would leave it. Refused when `parent`
	 * is itself a preview, when the preview has no running revision, its revision isn't healthy (or
	 * still being watched), or `commit` is given and isn't the commit it runs.
	 */
	async promote(input: {
		commit: string | null;
		parent: ServiceDTO;
		prNumber: number;
		userId: string;
	}): Promise<PromoteResult> {
		const { commit, parent, prNumber, userId } = input;
		if (parent.toJSON().previewParentId) {
			return {
				error: "A preview can't be promoted to, only the service it previews.",
				status: 400,
			};
		}
		const preview = await this.get(parent, prNumber);
		if (!preview) {
			return { error: `There's no preview for #${prNumber}.`, status: 404 };
		}
		const { revision } = preview;
		if (!revision) {
			return {
				error: `The preview of #${prNumber} has no running revision to promote.`,
				status: 409,
			};
		}
		if (commit && !sameCommit(revision.gitCommit, commit)) {
			return {
				error: `The preview of #${prNumber} runs ${revision.gitCommit ?? "an unknown commit"}, not ${commit}.`,
				status: 409,
			};
		}
		if (!PROMOTABLE_HEALTH.has(revision.health)) {
			return {
				error: `The preview of #${prNumber} is ${revision.health === "watching" ? "still being health-checked" : "unhealthy"}, so it isn't promoted.`,
				status: 409,
			};
		}
		const note = `Promoted from the preview of #${prNumber} (${preview.slug}, revision ${revision.id}, commit ${revision.gitCommit ?? "unknown"}): ${revision.imageRef ?? ""}`;
		const { deploymentId, jobId } = await DeploymentService.enqueueDeploy({
			note,
			rollbackOfDeploymentId: revision.id,
			svc: parent,
			trigger: "promote",
			userId,
		});
		logger.info(
			`Preview promoted: parent=${parent.id} pr=${prNumber} preview=${preview.id} revision=${revision.id} deployment=${deploymentId} user=${userId}`,
		);
		return { deploymentId, error: null, jobId, preview, revision };
	}

	/** Builds one preview's API view: its hostnames and URL, current revision and latest deploy attempt. */
	async #view(
		preview: ServiceDTO,
		stackSlug: string | undefined,
	): Promise<PreviewView> {
		const row = preview.toJSON();
		const [revisions, [latest]] = await Promise.all([
			RevisionService.list(preview),
			DeploymentDTO.listForService(preview.id, 1),
		]);
		const current = revisions.find((view) => view.current);
		const host = preview.dnsResolvable
			? primaryHostname(row, stackSlug, serviceDomain())
			: null;
		const scheme = config.traefik.entrypoint === "web" ? "http" : "https";
		const attempt = latest?.toJSON();
		return {
			branch: row.previewBranch,
			deployment: attempt
				? {
						createdAt: attempt.createdAt,
						errorMessage: attempt.errorMessage,
						finishedAt: attempt.finishedAt,
						gitCommit: attempt.gitCommit,
						gitRef: attempt.gitRef,
						id: attempt.id,
						status: attempt.status,
					}
				: null,
			gitRef: preview.gitRef,
			hostnames: preview.dnsResolvable
				? serviceHostnames(row, stackSlug, serviceDomain())
				: [],
			id: preview.id,
			name: preview.name,
			prNumber: row.previewPrNumber ?? 0,
			revision: current ? revisionOf(current) : null,
			slug: preview.slug,
			status: preview.currentStatus,
			title: row.previewPrTitle,
			url: host ? `${scheme}://${host}` : null,
		};
	}
}

export const PreviewApiService = new PreviewApiServiceClass();
