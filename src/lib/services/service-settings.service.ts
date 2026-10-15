import { config, serviceDomain } from "#lib/config.js";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import type { ServiceUpdateInput } from "#lib/dto/service-input.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { HOST_ACCESS_MESSAGE, hostAccessChanged } from "#lib/host-access.js";
import { Logger } from "#lib/logger.js";
import { authPathsProblem, pathFiltersChanged } from "#lib/path-patterns.js";
import { publishedPortsProblem } from "#lib/published-ports.js";
import { normalizeEnvironmentName } from "#lib/release-channels.js";
import { invalidateGatedService } from "#lib/server/gated-service-cache.js";
import {
	type DomainConflict,
	serviceDomainConflicts,
} from "#lib/server/hostname-owner.js";
import { listIconLibrary } from "#lib/server/icon-library.js";
import {
	type LoginWallPolicy,
	loginWallPolicyProblem,
} from "#lib/server/login-wall-form.js";
import { loginWallAvailability } from "#lib/server/login-wall-options.js";
import type { ServiceSettingsInput } from "#lib/server/validation/api.js";
import {
	previewDomainTemplateProblem,
	serviceHostnames,
} from "#lib/service-domains.js";
import { iconProblem } from "#lib/service-icon.js";
import {
	cronScheduleProblem,
	customSslChange,
	routingPatch,
} from "#lib/service-settings.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import { syncServiceDomainsDns } from "#lib/services/dns.service.js";
import { DockerService } from "#lib/services/docker.service.js";
import { takeOverDomains } from "#lib/services/domain-takeover.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { PreviewService } from "#lib/services/preview.service.js";
import {
	ReleaseChannelError,
	ReleaseChannelService,
} from "#lib/services/release-channel.service.js";
import { ScaleToZeroService } from "#lib/services/scale-to-zero.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { TEMPLATE_CATEGORIES } from "#lib/template-categories.js";

const logger = new Logger("Services");

/** A settings change refused for the caller's input; nothing was saved. */
export class ServiceSettingsError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}

	/** The JSON body a REST route answers this refusal with. */
	body(): Record<string, unknown> {
		return { error: this.message };
	}
}

/** Whether every conflict's owner is one a service can take a hostname from: another service or a redirect. */
function canTakeOver(conflicts: DomainConflict[]): boolean {
	return conflicts.every(
		(conflict) =>
			conflict.owner.kind === "service" || conflict.owner.kind === "redirect",
	);
}

/** A routing change refused because something else already routes a domain it adds; `canTakeOver` says whether `takeOverDomains` would move them here. */
export class DomainConflictError extends ServiceSettingsError {
	readonly canTakeOver: boolean;

	constructor(readonly conflicts: DomainConflict[]) {
		const takeable = canTakeOver(conflicts);
		super(
			`${conflicts.map((conflict) => `${conflict.entry} is already routed to ${conflict.owner.label}.`).join(" ")}${takeable ? " Take it over to move it to this service." : ""}`,
			409,
		);
		this.canTakeOver = takeable;
	}

	/** The message plus each conflicting entry with its owner, so a REST client can offer the takeover `takeOverDomains` does. */
	override body(): Record<string, unknown> {
		return {
			canTakeOver: this.canTakeOver,
			conflicts: this.conflicts.map(({ entry, owner }) => ({
				canTakeOver: canTakeOver([{ entry, owner }]),
				domain: entry,
				owner: owner.label,
				ownerId: "id" in owner ? owner.id : null,
				ownerKind: owner.kind,
			})),
			error: this.message,
		};
	}
}

export interface SettingsActor {
	/** Set when the change is part of a deploy already under way, which picks it up itself: no redeploy is queued. */
	deploying?: boolean;
	hostAccess: boolean;
	userId: string;
}

export interface SettingsResult {
	/** Previews deleted because their branch no longer passes the filters. */
	filteredOut: number;
	/** Whether a routing or login-wall change queued a redeploy. */
	redeploying: boolean;
	/** The owners domains were taken over from, which keep serving them until their own next deploy. */
	takenOver: string[];
}

type Row = ReturnType<ServiceDTO["toJSON"]>;

const CHANNEL_FIELDS = [
	"channelBranch",
	"channelCanaryDomain",
	"channelTagPattern",
	"channelsEnabled",
] as const;

function changed(before: Row, after: Row, keys: (keyof Row)[]): boolean {
	return keys.some(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	);
}

function fail(message: string, status = 400): never {
	throw new ServiceSettingsError(message, status);
}

/**
 * The columns an update sets besides its own fields: the environment name
 * normalised, host networking without public routing, the built-in cache
 * replacing a configured one, and secrets encrypted.
 */
function derivedColumns(
	fields: ServiceUpdateInput,
	input: ServiceSettingsInput,
): ServiceUpdateInput {
	const ssl = customSslChange(input);
	if (ssl && "error" in ssl) {
		fail(ssl.error);
	}
	const columns: ServiceUpdateInput = {};
	if (fields.environmentName !== undefined) {
		columns.environmentName = normalizeEnvironmentName(fields.environmentName);
	}
	if (fields.networkMode === "host") {
		columns.dnsResolvable = false;
	}
	if (fields.buildCacheBuiltin) {
		columns.buildCacheRegistryId = null;
	}
	if (fields.updateCheckEnabled === false) {
		columns.updateCheck = null;
	}
	if (input.registryPassword) {
		columns.registryPasswordEnc = encryptSecret(input.registryPassword);
	}
	if (ssl?.kind === "clear") {
		columns.customSslCertEnc = null;
		columns.customSslKeyEnc = null;
	}
	if (ssl?.kind === "set") {
		columns.customSslCertEnc = encryptSecret(ssl.cert);
		columns.customSslKeyEnc = encryptSecret(ssl.key);
	}
	return columns;
}

/**
 * Validates and applies a change to a service's settings, the one path the
 * REST API (and with it the Terraform provider) and the dashboard's settings
 * forms share: what each field needs checked, what it needs re-synced
 * (routing, DNS, certificates, webhooks, previews, release channels) and
 * when it calls for a redeploy.
 */
class ServiceSettingsServiceClass {
	/**
	 * Applies every field `input` carries to `svc`, leaving the rest alone.
	 *
	 * @throws {ServiceSettingsError} When a field is invalid or refused for
	 *   the actor; nothing is saved then. A release channel refusal comes
	 *   after the other fields were saved.
	 */
	async apply(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
		actor: SettingsActor,
	): Promise<SettingsResult> {
		const before = { ...svc.toJSON() };
		const { columns: patch, takeovers } = await this.#patch(svc, input, actor);
		const previous = serviceHostnames(
			before,
			await this.#stackSlug(before.stackId),
			serviceDomain(),
		);
		const takenOver =
			takeovers.length > 0
				? await takeOverDomains(takeovers, svc.id, actor.userId)
				: [];
		if (Object.keys(patch).length > 0) {
			await svc.update(patch);
		}
		const result = {
			...(await this.#resync(svc, before, actor, takenOver.length > 0)),
			takenOver,
		};
		const next = serviceHostnames(
			svc.toJSON(),
			await this.#stackSlug(svc.stackId),
			serviceDomain(),
		);
		if (svc.dnsResolvable && previous.join() !== next.join()) {
			void syncServiceDomainsDns(previous, next, svc.id);
		}
		if (patch.customSslCertEnc !== undefined) {
			await DockerService.syncCustomSslConfig(svc);
		}
		if (input.scaleToZeroMinutes !== undefined) {
			await ScaleToZeroService.configured(svc, before.scaleToZeroMinutes);
		}
		await this.#channels(svc, input, actor);
		logger.info(
			`Service settings updated: service=${svc.id} fields=${Object.keys(input).join(",")} user=${actor.userId}`,
		);
		return result;
	}

	/**
	 * `apply`, returning a refusal instead of throwing it, for a form action
	 * to turn into its own failure.
	 */
	async save(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
		actor: SettingsActor,
	): Promise<SettingsResult | ServiceSettingsError> {
		try {
			return await this.apply(svc, input, actor);
		} catch (err) {
			if (err instanceof ServiceSettingsError) {
				return err;
			}
			throw err;
		}
	}

	/** The columns `input` sets, checked and with secrets encrypted, and the domains to take over from their owners first. */
	async #patch(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
		actor: SettingsActor,
	): Promise<{ columns: ServiceUpdateInput; takeovers: DomainConflict[] }> {
		const {
			channelBranch: _branch,
			channelCanaryDomain: _canaryDomain,
			channelTagPattern: _tagPattern,
			channelsEnabled: _channelsEnabled,
			customSslCert: _cert,
			customSslKey: _key,
			registryPassword: _password,
			takeOverDomains,
			...fields
		} = input;
		const row = svc.toJSON();
		if (!actor.hostAccess && hostAccessChanged(row, fields)) {
			fail(HOST_ACCESS_MESSAGE, 403);
		}
		await this.#checkIdentity(svc, fields);
		await this.#checkSource(row, fields);
		this.#checkAccess(row, fields, await loginWallAvailability());
		await this.#checkNetwork(svc, fields);
		const routing = await this.#routing(svc, fields, takeOverDomains === true);
		return {
			columns: {
				...fields,
				...routing.columns,
				...derivedColumns(fields, input),
			},
			takeovers: routing.takeovers,
		};
	}

	/** Slug, stack, category and icon. */
	async #checkIdentity(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
	): Promise<void> {
		if (
			input.slug !== undefined &&
			input.slug !== svc.slug &&
			(await ServiceDTO.slugTaken(input.slug, svc.id))
		) {
			fail("That slug is already in use.", 409);
		}
		if (input.stackId && !(await StackDTO.get(input.stackId))) {
			fail("That stack wasn't found.");
		}
		if (
			input.category &&
			!TEMPLATE_CATEGORIES.some((entry) => entry.value === input.category)
		) {
			fail("Pick a type from the list.");
		}
		if (input.icon && input.icon !== svc.icon) {
			const bundled = (await listIconLibrary()).map((entry) => entry.icon);
			const problem = iconProblem(input.icon, bundled);
			if (problem) {
				fail(problem);
			}
		}
	}

	/** Build cache, build server, required status checks and the redeploy schedule. */
	async #checkSource(row: Row, input: ServiceSettingsInput): Promise<void> {
		if (
			input.buildCacheRegistryId &&
			!(await BuildCacheRegistryDTO.get(input.buildCacheRegistryId))
		) {
			fail("That build cache registry wasn't found.");
		}
		if (
			input.buildServerRemoteHostId &&
			!(await RemoteHostDTO.get(input.buildServerRemoteHostId))
		) {
			fail("That build server wasn't found.");
		}
		const checksTouched =
			input.requireStatusChecks !== undefined ||
			input.requiredStatusChecks !== undefined;
		if (
			checksTouched &&
			(input.requireStatusChecks ?? row.requireStatusChecks) &&
			(input.requiredStatusChecks ?? row.requiredStatusChecks).length === 0
		) {
			fail("Pick at least one check to require, or turn status checks off.");
		}
		const cronProblem = cronScheduleProblem(row, input);
		if (cronProblem) {
			fail(cronProblem);
		}
	}

	/** The login wall, its paths, and the previews' own wall and domains. */
	#checkAccess(
		row: Row,
		input: ServiceSettingsInput,
		available: Awaited<ReturnType<typeof loginWallAvailability>>,
	): void {
		const pathsProblem =
			input.authPathsMode === undefined && input.authPaths === undefined
				? null
				: authPathsProblem(
						input.authPathsMode ?? row.authPathsMode,
						input.authPaths ?? row.authPaths,
					);
		if (pathsProblem) {
			fail(pathsProblem);
		}
		const walls: { policy: LoginWallPolicy; touched: unknown[] }[] = [
			{
				policy: {
					authAllowedEmails: input.authAllowedEmails ?? row.authAllowedEmails,
					authAllowedGroups: input.authAllowedGroups ?? row.authAllowedGroups,
					authAllowedUserIds:
						input.authAllowedUserIds ?? row.authAllowedUserIds,
					authProviders: input.authProviders ?? row.authProviders,
					authRequired: input.authRequired ?? row.authRequired,
				},
				touched: [
					input.authAllowedEmails,
					input.authAllowedGroups,
					input.authAllowedUserIds,
					input.authProviders,
					input.authRequired,
				],
			},
			{
				policy: {
					authAllowedEmails:
						input.previewAuthAllowedEmails ?? row.previewAuthAllowedEmails,
					authAllowedGroups:
						input.previewAuthAllowedGroups ?? row.previewAuthAllowedGroups,
					authAllowedUserIds:
						input.previewAuthAllowedUserIds ?? row.previewAuthAllowedUserIds,
					authProviders: input.previewAuthProviders ?? row.previewAuthProviders,
					authRequired: input.previewAuthRequired ?? row.previewAuthRequired,
				},
				touched: [
					input.previewAuthAllowedEmails,
					input.previewAuthAllowedGroups,
					input.previewAuthAllowedUserIds,
					input.previewAuthProviders,
					input.previewAuthRequired,
				],
			},
		];
		for (const wall of walls) {
			const problem = wall.touched.some((value) => value !== undefined)
				? loginWallPolicyProblem(wall.policy, available, config.auth.origin)
				: null;
			if (problem) {
				fail(problem);
			}
		}
		this.#checkPreviewDomains(row, input);
	}

	/** A preview domain template that renders, and at least one preview hostname. */
	#checkPreviewDomains(row: Row, input: ServiceSettingsInput): void {
		if (
			input.previewDomainTemplate === undefined &&
			input.previewDefaultDomain === undefined
		) {
			return;
		}
		const template =
			input.previewDomainTemplate === undefined
				? row.previewDomainTemplate
				: input.previewDomainTemplate;
		const problem = template ? previewDomainTemplateProblem(template) : null;
		if (problem) {
			fail(problem);
		}
		if (
			!(template || (input.previewDefaultDomain ?? row.previewDefaultDomain))
		) {
			fail(
				"Set a preview domain template, or keep the default hostname: a preview needs at least one.",
			);
		}
	}

	/** Published ports: valid, and not published by another service. */
	async #checkNetwork(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
	): Promise<void> {
		if (!input.publishedPorts) {
			return;
		}
		const problem = publishedPortsProblem(input.publishedPorts);
		if (problem) {
			fail(problem);
		}
		const taken = await ServiceDTO.publishedPortTaken(
			input.publishedPorts,
			svc.id,
		);
		if (taken) {
			fail(
				`Host port ${taken.port.hostPort}/${taken.port.protocol} is already published by ${taken.serviceName}.`,
				409,
			);
		}
	}

	/**
	 * The routing columns the update sets, and the domain entries it adds
	 * (a new domain, or the default hostname a slug or stack change moves)
	 * that something else already routes: refused unless `takeOver` is set
	 * and every owner is a service or a redirect, in which case they're
	 * returned to be taken over.
	 */
	async #routing(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
		takeOver: boolean,
	): Promise<{
		columns: Partial<ServiceUpdateInput>;
		takeovers: DomainConflict[];
	}> {
		const row = svc.toJSON();
		const stackSlug = await this.#stackSlug(
			input.stackId === undefined ? row.stackId : input.stackId,
		);
		const routing = routingPatch(
			row,
			{
				containerPort: input.containerPort,
				defaultDomainEnabled: input.defaultDomainEnabled,
				domainPorts: input.domainPorts,
				domains: input.domains,
				primaryDomain: input.primaryDomain,
				slug: input.slug,
				stripPathDomains: input.stripPathDomains,
			},
			{ baseDomain: serviceDomain(), stackSlug },
		);
		if (routing && "error" in routing) {
			fail(routing.error);
		}
		const previous = serviceHostnames(
			row,
			await this.#stackSlug(row.stackId),
			serviceDomain(),
		);
		const next =
			routing?.hostnames ??
			serviceHostnames(
				{ ...row, slug: input.slug ?? row.slug },
				stackSlug,
				serviceDomain(),
			);
		const conflicts = await serviceDomainConflicts(
			next.filter((entry) => !previous.includes(entry)),
			svc.id,
		);
		if (conflicts.length > 0 && !(takeOver && canTakeOver(conflicts))) {
			throw new DomainConflictError(
				takeOver
					? conflicts.filter((conflict) => !canTakeOver([conflict]))
					: conflicts,
			);
		}
		return { columns: routing?.patch ?? {}, takeovers: conflicts };
	}

	/** Webhooks, previews, the login wall cache and redeploys after the row changed; a domain taken over queues a redeploy so it routes here as soon as possible. */
	async #resync(
		svc: ServiceDTO,
		before: Row,
		actor: SettingsActor,
		tookOver: boolean,
	): Promise<Omit<SettingsResult, "takenOver">> {
		const after = svc.toJSON();
		if (
			changed(before, after, [
				"autoDeployOnPush",
				"buildSource",
				"channelsEnabled",
				"gitProviderId",
				"gitRepo",
				"previewsEnabled",
			])
		) {
			await GitWebhookService.sync(svc, {
				channelsEnabled: before.channelsEnabled,
				gitProviderId: before.gitProviderId,
				gitRepo: before.gitRepo,
				gitWebhookId: before.gitWebhookId,
				previewsEnabled: before.previewsEnabled,
			});
		}
		let filteredOut = 0;
		if (
			(before.previewsEnabled && !after.previewsEnabled) ||
			before.buildSource !== after.buildSource
		) {
			await PreviewService.removeAll(svc);
		} else {
			if (
				after.previewsEnabled &&
				changed(before, after, ["previewBranchExclude", "previewBranchInclude"])
			) {
				filteredOut = await PreviewService.applyBranchFilter(svc);
			}
			if (
				changed(before, after, [
					"previewDefaultDomain",
					"previewDomainTemplate",
				])
			) {
				await PreviewService.applyDomains(svc);
			}
			if (
				changed(before, after, [
					"previewAuthAllowedEmails",
					"previewAuthAllowedGroups",
					"previewAuthAllowedUserIds",
					"previewAuthProviders",
					"previewAuthRequired",
				])
			) {
				await PreviewService.applyAccessPolicy(svc);
			}
		}
		invalidateGatedService(svc.id);
		if (actor.deploying) {
			return { filteredOut, redeploying: false };
		}
		const redeploying =
			tookOver || pathFiltersChanged(before, after)
				? await DeploymentService.redeployForRouting(svc, actor.userId)
				: await DeploymentService.redeployIfLoginWallChanged(
						svc,
						before.authRequired,
						actor.userId,
					);
		return { filteredOut, redeploying };
	}

	/** Release channels, through the same service the Channels tab uses. */
	async #channels(
		svc: ServiceDTO,
		input: ServiceSettingsInput,
		actor: SettingsActor,
	): Promise<void> {
		if (CHANNEL_FIELDS.every((key) => input[key] === undefined)) {
			return;
		}
		const row = svc.toJSON();
		const previous = {
			channelsEnabled: row.channelsEnabled,
			gitProviderId: svc.gitProviderId,
			gitRepo: svc.gitRepo,
			gitWebhookId: svc.gitWebhookId,
		};
		try {
			await ReleaseChannelService.configure(
				svc,
				{
					branch: input.channelBranch,
					canaryDomain: input.channelCanaryDomain,
					enabled: input.channelsEnabled ?? row.channelsEnabled,
					tagPattern: input.channelTagPattern,
				},
				actor.userId,
			);
		} catch (err) {
			if (err instanceof ReleaseChannelError) {
				fail(err.message);
			}
			throw err;
		}
		await GitWebhookService.sync(svc, previous);
	}

	/** The slug of a stack, null without one. */
	async #stackSlug(stackId: string | null | undefined): Promise<string | null> {
		return stackId ? ((await StackDTO.get(stackId))?.slug ?? null) : null;
	}
}

export const ServiceSettingsService = new ServiceSettingsServiceClass();
