import { serviceDomain } from "#lib/config.js";
import type { DeployTrigger } from "#lib/deploy-trigger.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceGitDTO } from "#lib/dto/service-git-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { canarySlug, tagPatternProblem } from "#lib/release-channels.js";
import { serviceDomainConflicts } from "#lib/server/hostname-owner.js";
import {
	DOMAIN_RE,
	primaryHostname,
	serviceHostnames,
} from "#lib/service-domains.js";
import type { ContainerStatus } from "#lib/types.js";
import { CapacityService } from "./capacity.service.ts";
import { DeploymentService } from "./deploy.service.ts";
import { syncServiceDomainsDns } from "./dns.service.ts";
import { mirroredSettings } from "./preview.service.ts";
import { ServiceLifecycleService } from "./service-lifecycle.service.ts";

const logger = new Logger("ReleaseChannels");

export interface ChannelSettings {
	branch?: string | null;
	canaryDomain?: string | null;
	enabled: boolean;
	tagPattern?: string;
}

export interface ChannelStatus {
	branch: string | null;
	canary: {
		gitRef: string | null;
		hostname: string | null;
		id: string;
		name: string;
		slug: string;
		status: ContainerStatus;
	} | null;
	canaryDomain: string | null;
	enabled: boolean;
	stableRef: string | null;
	tagPattern: string;
}

export interface ChannelDeployResult {
	deploymentId: string;
	jobId: string;
	serviceId: string;
	status: "deployed";
}

export class ReleaseChannelError extends Error {
	override name = "ReleaseChannelError";
}

/** The domain columns a canary gets from its parent's canary domain: that domain when set, else only its default hostname. */
/** The parent's settings a canary mirrors: a preview's, without the preview-only uptime choice, so the canary keeps its own probes. */
function canarySettings(parent: ServiceDTO) {
	const { uptimeEnabled: _uptimeEnabled, ...settings } =
		mirroredSettings(parent);
	return settings;
}

function canaryDomains(canaryDomain: string | null) {
	return {
		defaultDomainEnabled: !canaryDomain,
		domains: canaryDomain ? [canaryDomain] : [],
		primaryDomain: canaryDomain,
	};
}

/**
 * Release channels: a git service with channels on is the stable
 * environment, deployed when a tag matching its pattern is pushed, and
 * Homerun keeps a companion canary service, `<slug>-canary`, mirroring its
 * settings and deployed on every push to the canary branch.
 */
class ReleaseChannelServiceClass {
	/**
	 * The channel settings and canary of a service, for the Channels tab and
	 * the API.
	 */
	async status(parent: ServiceDTO): Promise<ChannelStatus> {
		const row = parent.toJSON();
		const canary = await ServiceGitDTO.getCanary(parent.id);
		const stack =
			canary && parent.stackId ? await StackDTO.get(parent.stackId) : null;
		return {
			branch: row.channelBranch,
			canary: canary
				? {
						gitRef: canary.gitRef,
						hostname: canary.dnsResolvable
							? primaryHostname(canary.toJSON(), stack?.slug, serviceDomain())
							: null,
						id: canary.id,
						name: canary.name,
						slug: canary.slug,
						status: canary.currentStatus,
					}
				: null,
			canaryDomain: row.channelCanaryDomain,
			enabled: row.channelsEnabled,
			stableRef: parent.gitRef,
			tagPattern: row.channelTagPattern,
		};
	}

	/**
	 * Turns release channels on, off or changes their settings. On creates the
	 * canary (and deploys it) or refreshes it, redeploying it when its branch
	 * or domain changed; off deletes the canary. The caller re-syncs the
	 * webhook afterwards (`GitWebhookService.sync` with `channelsEnabled` in
	 * the snapshot), since a GitLab hook needs tag push events.
	 *
	 * @throws {ReleaseChannelError} When the service can't have channels or a
	 * setting is invalid; nothing is changed then.
	 */
	async configure(
		parent: ServiceDTO,
		settings: ChannelSettings,
		userId: string,
	): Promise<void> {
		const before = { ...parent.toJSON() };
		if (
			settings.enabled &&
			!before.channelsEnabled &&
			(await ServiceGitDTO.listEnvironments(parent.id)).some(
				(environment) => environment.toJSON().environmentName === "canary",
			)
		) {
			throw new ReleaseChannelError(
				"This service has a canary environment: delete it before turning release channels on, their canary takes its place.",
			);
		}
		const existing = await ServiceGitDTO.getCanary(parent.id);
		const { branch, canaryDomain, tagPattern } = await this.#resolveSettings(
			parent,
			settings,
			existing,
		);

		await parent.update({
			channelBranch: branch,
			channelCanaryDomain: canaryDomain,
			channelTagPattern: tagPattern,
			channelsEnabled: settings.enabled,
		});
		logger.info(
			`Release channels ${settings.enabled ? "configured" : "turned off"}: service=${parent.id} branch=${branch} tags=${tagPattern} canaryDomain=${canaryDomain ?? "-"} user=${userId}`,
		);

		if (!settings.enabled) {
			if (existing) {
				await ServiceLifecycleService.deleteService(existing, {
					cancelJobs: true,
				});
				logger.info(
					`Canary removed: parent=${parent.id} service=${existing.id}`,
				);
			}
			return;
		}
		if (
			!existing ||
			!before.channelsEnabled ||
			existing.gitRef !== branch ||
			before.channelCanaryDomain !== canaryDomain
		) {
			await this.deployCanary(parent, { trigger: "manual", userId });
		}
	}

	/**
	 * The settings `configure` saves: each one given, else the one already
	 * set, the branch falling back to the service's own.
	 *
	 * @throws {ReleaseChannelError} When the service can't have channels, the
	 * tag pattern or canary domain is invalid, or the domain is routed to
	 * another service.
	 */
	async #resolveSettings(
		parent: ServiceDTO,
		settings: ChannelSettings,
		existing: ServiceDTO | null,
	): Promise<{
		branch: string;
		canaryDomain: string | null;
		tagPattern: string;
	}> {
		const before = parent.toJSON();
		if (parent.buildSource !== "git" || before.previewParentId) {
			throw new ReleaseChannelError(
				"Release channels need a service built from git that isn't a preview or a canary itself.",
			);
		}
		const tagPattern = settings.tagPattern?.trim() || before.channelTagPattern;
		const patternProblem = tagPatternProblem(tagPattern);
		if (patternProblem) {
			throw new ReleaseChannelError(patternProblem);
		}
		const canaryDomain =
			settings.canaryDomain === undefined
				? before.channelCanaryDomain
				: settings.canaryDomain?.trim().toLowerCase() || null;
		if (canaryDomain && !DOMAIN_RE.test(canaryDomain)) {
			throw new ReleaseChannelError(`"${canaryDomain}" isn't a valid domain.`);
		}
		if (settings.enabled && canaryDomain) {
			await this.#assertCanaryDomainFree(parent, canaryDomain, existing);
		}
		const branch =
			settings.branch?.trim() ||
			before.channelBranch ||
			parent.gitRef ||
			"main";
		return { branch, canaryDomain, tagPattern };
	}

	/**
	 * Deploys the canary from the canary branch, creating it first when it
	 * doesn't exist yet, and refreshing its mirrored settings, branch and
	 * domains from the parent otherwise. `commit` is the head a push or poll
	 * saw, recorded so polling doesn't deploy it a second time.
	 *
	 * @throws {ReleaseChannelError} When channels are off, the canary slug is
	 * taken by another service, or the instance is at capacity.
	 */
	async deployCanary(
		parent: ServiceDTO,
		options: { commit?: string | null; trigger: DeployTrigger; userId: string },
	): Promise<ChannelDeployResult> {
		if (!parent.toJSON().channelsEnabled) {
			throw new ReleaseChannelError(
				"Release channels are off for this service, so it has no canary.",
			);
		}
		const canary = await this.#ensureCanary(parent);
		if (options.commit) {
			await canary.update({ gitLastSeenCommit: options.commit });
		}
		const { deploymentId, jobId } = await DeploymentService.enqueueDeploy({
			svc: canary,
			trigger: options.trigger,
			userId: options.userId,
		});
		return { deploymentId, jobId, serviceId: canary.id, status: "deployed" };
	}

	/**
	 * Deploys the stable service, at `tag` when one was pushed (saved as its
	 * git ref so later redeploys keep building it), else at its current ref.
	 */
	async deployStable(
		parent: ServiceDTO,
		options: { tag?: string; trigger: DeployTrigger; userId: string },
	): Promise<ChannelDeployResult> {
		if (options.tag && options.tag !== parent.gitRef) {
			await parent.update({ gitRef: options.tag });
		}
		const { deploymentId, jobId } = await DeploymentService.enqueueDeploy({
			svc: parent,
			trigger: options.trigger,
			userId: options.userId,
		});
		return { deploymentId, jobId, serviceId: parent.id, status: "deployed" };
	}

	/**
	 * Refuses a canary domain the stable service itself answers at or
	 * something else already routes: Homerun itself, a workstation, a
	 * redirect or another service.
	 *
	 * @throws {ReleaseChannelError} When the domain is taken.
	 */
	async #assertCanaryDomainFree(
		parent: ServiceDTO,
		canaryDomain: string,
		existing: ServiceDTO | null,
	): Promise<void> {
		const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
		const own = serviceHostnames(parent.toJSON(), stack?.slug, serviceDomain());
		if (own.includes(canaryDomain)) {
			throw new ReleaseChannelError(
				`${canaryDomain} is where this service itself answers: pick another domain for the canary.`,
			);
		}
		const [taken] = await serviceDomainConflicts([canaryDomain], existing?.id);
		if (taken) {
			throw new ReleaseChannelError(
				`${canaryDomain} is already routed to ${taken.owner.label}.`,
			);
		}
	}

	/** The parent's canary with its mirrored settings, branch and domains brought up to date, created when missing. */
	async #ensureCanary(parent: ServiceDTO): Promise<ServiceDTO> {
		const row = parent.toJSON();
		const branch = row.channelBranch || parent.gitRef || "main";
		const domains = canaryDomains(row.channelCanaryDomain);
		const existing = await ServiceGitDTO.getCanary(parent.id);
		if (existing) {
			const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
			const previous = serviceHostnames(
				existing.toJSON(),
				stack?.slug,
				serviceDomain(),
			);
			await existing.update({
				...canarySettings(parent),
				...domains,
				gitRef: branch,
			});
			const next = serviceHostnames(
				existing.toJSON(),
				stack?.slug,
				serviceDomain(),
			);
			if (existing.dnsResolvable && previous.join() !== next.join()) {
				void syncServiceDomainsDns(previous, next, existing.id);
			}
			return existing;
		}

		const slug = canarySlug(parent.slug);
		if (await ServiceDTO.slugTaken(slug)) {
			throw new ReleaseChannelError(
				`The slug ${slug} is already taken by another service.`,
			);
		}
		const full = await CapacityService.refusal();
		if (full) {
			throw new ReleaseChannelError(full);
		}
		const settings = canarySettings(parent);
		const canary = await ServiceDTO.create({
			...settings,
			autoDeployOnPush: true,
			buildSource: "git",
			channelCanary: true,
			domains: domains.domains,
			gitRef: branch,
			image: parent.image,
			name: `${parent.name} (canary)`,
			networkMode: "bridge",
			portProtocol: parent.portProtocol,
			previewParentId: parent.id,
			pullPolicy: parent.pullPolicy,
			restartPolicy: parent.restartPolicy,
			slug,
			stackId: parent.stackId,
			tag: parent.tag,
			userId: parent.userId,
		});
		await canary.update({
			authAllowedEmails: settings.authAllowedEmails,
			authAllowedGroups: settings.authAllowedGroups,
			authAllowedUserIds: settings.authAllowedUserIds,
			authProviders: settings.authProviders,
			defaultDomainEnabled: domains.defaultDomainEnabled,
			primaryDomain: domains.primaryDomain,
		});
		logger.info(
			`Canary created: parent=${parent.id} service=${canary.id} branch=${branch}`,
		);
		return canary;
	}
}

export const ReleaseChannelService = new ReleaseChannelServiceClass();
