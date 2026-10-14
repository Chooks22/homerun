import { serviceDomain } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ServiceGitDTO } from "#lib/dto/service-git-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import type { PushedBranch } from "#lib/git-webhooks.js";
import { Logger } from "#lib/logger.js";
import {
	deployEnvironment,
	newEnvironmentProblem,
} from "#lib/release-channels.js";
import { serviceDomainConflicts } from "#lib/server/hostname-owner.js";
import {
	primaryHostname,
	rewriteHostnames,
	serviceHostnames,
} from "#lib/service-domains.js";
import { childSlug } from "#lib/slug.js";
import { pushMatchesWatchPaths } from "#lib/watch-paths.js";
import { CapacityService } from "./capacity.service.ts";
import { DeploymentService } from "./deploy.service.ts";
import { syncServiceDomainsDns } from "./dns.service.ts";
import { GitHubReportService } from "./github-report.service.ts";
import { mirroredSettings } from "./preview.service.ts";
import { ServiceLifecycleService } from "./service-lifecycle.service.ts";

const logger = new Logger("Environments");

/** A refused environment change, with a message for the person making it. */
export class EnvironmentError extends Error {
	override name = "EnvironmentError";
}

export interface EnvironmentInput {
	domain: string | null;
	envOverrides: Record<string, string>;
	ref: string;
}

/** The slug of `name`'s environment of a service: `<slug>-<name>`, see `childSlug`. */
export function environmentSlug(parentSlug: string, name: string): string {
	return childSlug(parentSlug, name);
}

/** The parent's build and runtime settings an environment starts with, without its env vars: those are worked out separately. */
function copiedSettings(parent: ServiceDTO) {
	const {
		envVars: _envVars,
		uptimeEnabled: _uptimeEnabled,
		...settings
	} = mirroredSettings(parent);
	return settings;
}

/**
 * The environments of a service: more deployments of it under a name of
 * their own (staging, demo, a second production...), each a child service
 * that starts with a copy of the parent's build and runtime settings and is
 * independent from then on (edited on its own tabs like any service), with
 * its own source (the branch a git service builds, the tag an image service
 * runs), its own domains and its own env vars, which start as the parent's
 * with the parent's hostnames pointed at the environment. The parent itself is one
 * environment (`production` unless renamed in its settings); its canary and
 * pull request previews are others, managed by their own features.
 */
class EnvironmentServiceClass {
	/** The environments created on `parent`, by name. */
	async list(parent: ServiceDTO): Promise<ServiceDTO[]> {
		return await ServiceGitDTO.listEnvironments(parent.id);
	}

	/**
	 * Creates `name`'s environment of `parent` and, unless `deploy` is false,
	 * queues its first deploy as `userId`.
	 *
	 * @throws EnvironmentError when the name, slug or domain is taken, or the
	 *   instance is full.
	 */
	async create(
		parent: ServiceDTO,
		name: string,
		input: EnvironmentInput,
		{ deploy = true, userId }: { deploy?: boolean; userId: string },
	): Promise<ServiceDTO> {
		const row = parent.toJSON();
		if (row.previewParentId) {
			throw new EnvironmentError(
				"Environments are created on the service itself, not on one of its environments.",
			);
		}
		const existing = await this.list(parent);
		const problem = newEnvironmentProblem(name, {
			channelsEnabled: row.channelsEnabled,
			taken: [
				deployEnvironment(row),
				...existing.map((entry) => entry.toJSON().environmentName ?? ""),
			],
		});
		if (problem) {
			throw new EnvironmentError(problem);
		}
		const slug = environmentSlug(parent.slug, name);
		if (await ServiceDTO.slugTaken(slug)) {
			throw new EnvironmentError(
				`The slug ${slug} is already taken by another service.`,
			);
		}
		await this.#assertDomainFree(input.domain);
		const full = await CapacityService.refusal();
		if (full) {
			throw new EnvironmentError(full);
		}

		const environment = await ServiceDTO.create({
			...copiedSettings(parent),
			autoDeployOnPush: parent.autoDeployOnPush,
			buildSource: parent.buildSource,
			gitIgnorePaths: parent.toJSON().gitIgnorePaths,
			gitWatchPaths: parent.toJSON().gitWatchPaths,
			domains: input.domain ? [input.domain] : [],
			envVars: {},
			gitRef: parent.buildSource === "git" ? input.ref : parent.gitRef,
			image: parent.image,
			name: `${parent.name} (${name})`,
			networkMode: "bridge",
			portProtocol: parent.portProtocol,
			previewParentId: parent.id,
			pullPolicy: parent.pullPolicy,
			restartPolicy: parent.restartPolicy,
			slug,
			stackId: parent.stackId,
			tag: parent.buildSource === "git" ? parent.tag : input.ref,
			userId: parent.userId,
		});
		try {
			await environment.update({
				environmentName: name,
				envVars: await this.#initialEnv(parent, environment, input),
				primaryDomain: input.domain,
			});
		} catch (err) {
			await ServiceLifecycleService.deleteService(environment, {
				cancelJobs: true,
			}).catch((cleanup: unknown) => {
				logger.warn(
					`Couldn't remove a half-created environment: service=${environment.id}`,
					cleanup,
				);
			});
			throw err;
		}
		logger.info(
			`Environment created: parent=${parent.id} name=${name} service=${environment.id} ref=${input.ref}`,
		);
		if (deploy) {
			await DeploymentService.enqueueDeploy({
				svc: environment,
				trigger: "manual",
				userId,
			});
		}
		return environment;
	}

	/**
	 * Points an environment at a new source and main domain (any other domain
	 * set on its own Networking tab is kept). Its other settings and env vars
	 * are left alone (they're edited on the environment itself), except
	 * `envOverrides`, set on top. Doesn't deploy.
	 *
	 * @throws EnvironmentError when it isn't one of `parent`'s environments or
	 *   the domain is taken.
	 */
	async update(
		parent: ServiceDTO,
		environmentId: string,
		input: EnvironmentInput,
	): Promise<ServiceDTO> {
		const environment = await this.#own(parent, environmentId);
		await this.#assertDomainFree(input.domain, environment.id);
		const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
		const previous = serviceHostnames(
			environment.toJSON(),
			stack?.slug,
			serviceDomain(),
		);
		const row = environment.toJSON();
		const replaced = row.primaryDomain ?? row.domains[0] ?? null;
		const others = row.domains.filter(
			(domain) => domain !== replaced && domain !== input.domain,
		);
		await environment.update({
			domains: input.domain ? [input.domain, ...others] : others,
			envVars: { ...environment.envVars, ...input.envOverrides },
			gitRef: parent.buildSource === "git" ? input.ref : environment.gitRef,
			primaryDomain: input.domain ?? others[0] ?? null,
			tag: parent.buildSource === "git" ? environment.tag : input.ref,
		});
		const next = serviceHostnames(
			environment.toJSON(),
			stack?.slug,
			serviceDomain(),
		);
		if (environment.dnsResolvable && previous.join() !== next.join()) {
			void syncServiceDomainsDns(previous, next, environment.id);
		}
		logger.info(
			`Environment updated: parent=${parent.id} service=${environment.id} ref=${input.ref}`,
		);
		return environment;
	}

	/**
	 * Deletes an environment of `parent`: its workload, DNS records and row.
	 *
	 * @throws EnvironmentError when it isn't one of `parent`'s environments.
	 */
	async delete(parent: ServiceDTO, environmentId: string): Promise<void> {
		const environment = await this.#own(parent, environmentId);
		await ServiceLifecycleService.deleteService(environment, {
			cancelJobs: true,
		});
		GitHubReportService.environmentRemoved(
			parent,
			environment.toJSON().environmentName ?? environment.slug,
		);
		logger.info(
			`Environment deleted: parent=${parent.id} service=${environment.id}`,
		);
	}

	/**
	 * Deploys, as the parent's owner, every environment of a git service that
	 * builds a branch one of `pushes` moved and deploys on push, unless it
	 * already deployed that commit or none of the pushed files passes its own
	 * watch paths (the commit is still recorded as seen, so polling doesn't
	 * deploy it either). Never throws: a failed enqueue is logged.
	 *
	 * @returns How many environments were queued.
	 */
	async deployPushes(
		parent: ServiceDTO,
		pushes: PushedBranch[],
	): Promise<number> {
		if (parent.buildSource !== "git" || pushes.length === 0) {
			return 0;
		}
		const environments = (
			await this.list(parent).catch((err: unknown) => {
				logger.warn(
					`Couldn't list environments to deploy on push: service=${parent.id}`,
					err,
				);
				return [];
			})
		).filter(
			(entry) =>
				entry.autoDeployOnPush &&
				pushes.some((push) => push.branch === entry.gitRef),
		);
		const queued = await Promise.all(
			environments.map(async (environment) => {
				const push = pushes.find(
					(entry) => entry.branch === environment.gitRef,
				);
				if (
					push?.commit &&
					environment.toJSON().gitLastSeenCommit === push.commit
				) {
					return 0;
				}
				try {
					if (push?.commit) {
						await environment.update({ gitLastSeenCommit: push.commit });
					}
					if (
						!pushMatchesWatchPaths(push?.files ?? null, {
							ignore: environment.toJSON().gitIgnorePaths,
							watch: environment.toJSON().gitWatchPaths,
						})
					) {
						return 0;
					}
					await this.deploy(parent, environment, "push");
					return 1;
				} catch (err) {
					logger.warn(
						`Couldn't deploy environment on push: service=${environment.id}`,
						err,
					);
					return 0;
				}
			}),
		);
		return queued.reduce((sum: number, count) => sum + count, 0);
	}

	/** Queues a deploy of an environment as `parent`'s owner: how a push, through the webhook or the poller, deploys one. */
	async deploy(
		parent: ServiceDTO,
		environment: ServiceDTO,
		trigger: "manual" | "push",
	): Promise<{ deploymentId: string }> {
		return await DeploymentService.enqueueDeploy({
			svc: environment,
			trigger,
			userId: parent.userId,
		});
	}

	/** The environment `environmentId` when it belongs to `parent`, else throws. */
	async #own(parent: ServiceDTO, environmentId: string): Promise<ServiceDTO> {
		const environment = (await this.list(parent)).find(
			(entry) => entry.id === environmentId,
		);
		if (!environment) {
			throw new EnvironmentError(
				"That isn't one of this service's environments.",
			);
		}
		return environment;
	}

	/** Throws when something other than the service `exceptId` already routes `domain`: Homerun itself, a workstation, a redirect or another service. */
	async #assertDomainFree(
		domain: string | null,
		exceptId?: string,
	): Promise<void> {
		const [taken] = domain
			? await serviceDomainConflicts([domain], exceptId)
			: [];
		if (taken) {
			throw new EnvironmentError(
				`${domain} is already routed to ${taken.owner.label}.`,
			);
		}
	}

	/** The parent's env vars with its own hostnames pointed at the environment's, then `input.envOverrides` on top. */
	async #initialEnv(
		parent: ServiceDTO,
		environment: ServiceDTO,
		input: EnvironmentInput,
	): Promise<Record<string, string>> {
		const stack = parent.stackId ? await StackDTO.get(parent.stackId) : null;
		const inherited = rewriteHostnames(
			parent.envVars ?? {},
			serviceHostnames(parent.toJSON(), stack?.slug, serviceDomain()),
			primaryHostname(environment.toJSON(), stack?.slug, serviceDomain()),
		);
		return { ...inherited, ...input.envOverrides };
	}
}

export const EnvironmentService = new EnvironmentServiceClass();
