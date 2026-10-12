import {
	and,
	arrayOverlaps,
	asc,
	count,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { PASSWORD_METHOD } from "#lib/auth-providers.js";
import type { BuildMethod } from "#lib/build-methods.js";
import { SERVICE_STATUS_CONFIG, UNGROUPED_LABEL } from "#lib/constants.js";
import type { AuthPathsMode } from "#lib/path-patterns.js";
import type { PublishedPort } from "#lib/published-ports.js";
import { db } from "#lib/server/db/lib.js";
import { type Service, service, stack } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	narrowFilter,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { isDatabaseImage } from "#lib/service-link.js";
import { runtimeOptionsFrom } from "#lib/service-runtime.js";
import type { ContainerStatus, PullPolicy } from "#lib/types.js";
import { BaseDTO } from "./base-dto";
import type { NewServiceInput, ServiceUpdateInput } from "./service-input";
import { NEW_SERVICE_VERSION_COLUMNS } from "./service-input";

const preview = alias(service, "preview");

/**
 * Wraps the `service` table : every route that touches a service goes
 * through here instead of writing its own Drizzle query. Resources are shared
 * across every account on the instance, so no finder filters by `userId`,
 * which only records who created the service.
 */
export class ServiceDTO extends BaseDTO<Service> {
	/** Loads one service by id; null when missing. */
	static async get(id: string): Promise<ServiceDTO | null> {
		const [row] = await db
			.select()
			.from(service)
			.where(eq(service.id, id))
			.limit(1);
		return row ? new ServiceDTO(row) : null;
	}

	/** Every service on the instance, newest first. */
	static async list(): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.orderBy(desc(service.createdAt));
		return rows.map((row) => new ServiceDTO(row));
	}

	/** Every service whose git builds cache their layers in build cache registry `registryId`, by name. */
	static async listByBuildCacheRegistry(
		registryId: string,
	): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(eq(service.buildCacheRegistryId, registryId))
			.orderBy(asc(service.name));
		return rows.map((row) => new ServiceDTO(row));
	}

	/** Every service in one stack, newest first. */
	static async listByStack(stackId: string): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(eq(service.stackId, stackId))
			.orderBy(desc(service.createdAt));
		return rows.map((row) => new ServiceDTO(row));
	}

	/**
	 * Same as `list`, plus each service's stack name (for the "Ungrouped"
	 * bucket the services list groups by) : a dedicated query rather than
	 * bolting a join onto `list`, since the two callers want different shapes.
	 */
	static async listWithStackNames(): Promise<
		Array<{ stackName: string | null; service: ServiceDTO }>
	> {
		const rows = await db
			.select({ stackName: stack.name, row: service })
			.from(service)
			.leftJoin(stack, eq(service.stackId, stack.id))
			.orderBy(desc(service.createdAt));
		return rows.map((r) => ({
			stackName: r.stackName,
			service: new ServiceDTO(r.row),
		}));
	}

	/**
	 * Builds the WHERE clause for the paged services list : the search box
	 * (name, slug, image, tag, or any of the service's previews), status
	 * pills, and stack pills where the Ungrouped label means no stack. Pull
	 * request previews are left out unless `includePreviews`: the dashboard
	 * lists them under their parent, the REST API returns every service.
	 */
	static #listFilters(
		query: ListQuery,
		includePreviews: boolean,
	): SQL | undefined {
		const conditions: SQL[] = includePreviews
			? []
			: [isNull(service.previewParentId)];

		const search = searchCondition(query.q, [
			service.name,
			service.slug,
			service.image,
			service.tag,
		]);
		const previewSearch = searchCondition(query.q, [
			preview.name,
			preview.slug,
			preview.previewBranch,
			preview.previewPrTitle,
		]);
		if (search && previewSearch) {
			conditions.push(
				or(
					search,
					exists(
						db
							.select({ id: preview.id })
							.from(preview)
							.where(
								and(eq(preview.previewParentId, service.id), previewSearch),
							),
					),
				) as SQL,
			);
		}

		const statuses = narrowFilter(
			query.filters.status,
			Object.keys(SERVICE_STATUS_CONFIG) as ContainerStatus[],
		);
		if (statuses.length > 0) {
			conditions.push(inArray(service.currentStatus, statuses));
		}

		const stacks = query.filters.stack;
		if (stacks && stacks.length > 0) {
			const named = stacks.filter((p) => p !== UNGROUPED_LABEL);
			const parts: SQL[] = [];
			if (named.length > 0) {
				parts.push(inArray(stack.name, named));
			}
			if (stacks.includes(UNGROUPED_LABEL)) {
				parts.push(isNull(service.stackId));
			}
			const combined = or(...parts);
			if (combined) {
				conditions.push(combined);
			}
		}

		return and(...conditions);
	}

	/** One page of `listWithStackNames`, filtered/searched server-side, plus the unpaged total the pager needs. Pull request previews are only rows of their own with `includePreviews`. */
	static async listWithStackNamesPaged(
		query: ListQuery,
		{ includePreviews = false }: { includePreviews?: boolean } = {},
	): Promise<PagedResult<{ stackName: string | null; service: ServiceDTO }>> {
		const where = ServiceDTO.#listFilters(query, includePreviews);
		const [rows, totals] = await Promise.all([
			db
				.select({ stackName: stack.name, row: service })
				.from(service)
				.leftJoin(stack, eq(service.stackId, stack.id))
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: service.createdAt,
							name: service.name,
							updated: service.updatedAt,
						},
						desc(service.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db
				.select({ total: count() })
				.from(service)
				.leftJoin(stack, eq(service.stackId, stack.id))
				.where(where),
		]);
		return {
			items: rows.map((r) => ({
				stackName: r.stackName,
				service: new ServiceDTO(r.row),
			})),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/** Every distinct status/stack the instance's services actually use, for the list page's filter pills (which must stay stable regardless of the current page). */
	static async listFilterFacets(): Promise<{
		stacks: string[];
		statuses: string[];
	}> {
		const rows = await db
			.selectDistinct({
				stackName: stack.name,
				status: service.currentStatus,
			})
			.from(service)
			.leftJoin(stack, eq(service.stackId, stack.id));
		return {
			stacks: [
				...new Set(rows.map((r) => r.stackName ?? UNGROUPED_LABEL)),
			].sort(),
			statuses: [...new Set(rows.map((r) => r.status))].sort(),
		};
	}

	/** Every service with cron redeploys turned on : for the scheduler tick. */
	static async listCronEnabled(): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(eq(service.cronEnabled, true));
		return rows.map((row) => new ServiceDTO(row));
	}

	/**
	 * Every running service with a live container or a swarm service, for the
	 * per-minute stats sampler and uptime probe.
	 */
	static async listRunningWithContainers(): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				and(
					or(isNotNull(service.containerId), isNotNull(service.swarmServiceId)),
					eq(service.currentStatus, "running"),
				),
			);
		return rows.map((row) => new ServiceDTO(row));
	}

	/** The first of `domains` another service (not `excludeId`) already routes, or null when they're all free. */
	static async domainTaken(
		domains: string[],
		excludeId?: string,
	): Promise<string | null> {
		if (domains.length === 0) {
			return null;
		}
		const overlap = arrayOverlaps(service.domains, domains);
		const rows = await db
			.select({ domains: service.domains })
			.from(service)
			.where(excludeId ? and(overlap, ne(service.id, excludeId)) : overlap);
		const taken = new Set(rows.flatMap((row) => row.domains));
		return domains.find((domain) => taken.has(domain)) ?? null;
	}

	/**
	 * The first of `ports` another service (not `excludeId`) already publishes
	 * on the same host port and protocol, with that service's name, or null.
	 */
	static async publishedPortTaken(
		ports: PublishedPort[],
		excludeId: string,
	): Promise<{ port: PublishedPort; serviceName: string } | null> {
		if (ports.length === 0) {
			return null;
		}
		const rows = await db
			.select({ name: service.name, publishedPorts: service.publishedPorts })
			.from(service)
			.where(ne(service.id, excludeId));
		for (const port of ports) {
			const owner = rows.find((row) =>
				row.publishedPorts.some(
					(other) =>
						other.hostPort === port.hostPort &&
						other.protocol === port.protocol,
				),
			);
			if (owner) {
				return { port, serviceName: owner.name };
			}
		}
		return null;
	}

	/** Whether `slug` is already taken by a *different* service (for uniqueness checks on create/update). */
	static async slugTaken(slug: string, excludeId?: string): Promise<boolean> {
		const conditions = excludeId
			? and(eq(service.slug, slug), ne(service.id, excludeId))
			: eq(service.slug, slug);
		const [row] = await db
			.select({ id: service.id })
			.from(service)
			.where(conditions)
			.limit(1);
		return !!row;
	}

	/** How a git service is built : the build method and its per-method file, target and context settings. */
	static #buildMethodColumns(input: NewServiceInput) {
		return {
			gitBakeFile: input.gitBakeFile ?? null,
			gitBuildTarget: input.gitBuildTarget ?? null,
			gitBuildContext: input.gitBuildContext ?? null,
			gitBuildMethod: input.gitBuildMethod ?? "dockerfile",
			gitDockerfilePath: input.gitDockerfilePath ?? null,
		} satisfies Partial<Service>;
	}

	/** Where the image comes from : registry coordinates plus the git-build fields, all optional with a default. */
	static #buildColumns(input: NewServiceInput) {
		return {
			buildCacheRegistryId: input.buildCacheRegistryId ?? null,
			buildCacheBuiltin: input.buildCacheBuiltin ?? false,
			buildServerRemoteHostId: input.buildServerRemoteHostId ?? null,
			buildSource: input.buildSource ?? "image",
			...ServiceDTO.#buildMethodColumns(input),
			gitRef: input.gitRef ?? null,
			gitUrl: input.gitUrl ?? null,
			gitProviderId: input.gitProviderId ?? null,
			gitRepo: input.gitRepo ?? null,
			autoDeployOnPush: input.autoDeployOnPush ?? false,
			gitIgnorePaths: input.gitIgnorePaths ?? [],
			gitWatchPaths: input.gitWatchPaths ?? [],
			gitWebhookId: null,
			gitWebhookSecretEnc: null,
			gitWebhookError: null,
			registryPasswordEnc: input.registryPasswordEnc ?? null,
			registryUrl: input.registryUrl ?? null,
			registryUsername: input.registryUsername ?? null,
		} satisfies Partial<Service>;
	}

	/** Push polling, webhook reconnect and pull request preview columns, all off for a new service unless it is itself a preview. */
	static #gitTriggerColumns(input: NewServiceInput) {
		return {
			gitLastSeenCommit: null,
			gitPollEnabled: false,
			gitWebhookReconnect: false,
			previewBranch: input.previewBranch ?? null,
			previewParentId: input.previewParentId ?? null,
			previewPrNumber: input.previewPrNumber ?? null,
			previewPrTitle: input.previewPrTitle ?? null,
			previewAuthAllowedEmails: [],
			previewAuthAllowedGroups: [],
			previewAuthAllowedUserIds: [],
			previewAuthProviders: [],
			previewAuthRequired: false,
			previewDefaultDomain: true,
			previewReportGithub: true,
			previewBranchExclude: [],
			previewBranchInclude: [],
			previewCopyVolumes: false,
			previewEnvOverrides: {},
			previewInheritEnv: true,
			previewDomainTemplate: null,
			previewsEnabled: false,
			channelsEnabled: false,
			channelBranch: null,
			channelTagPattern: "v*",
			channelCanaryDomain: null,
			channelCanary: input.channelCanary ?? false,
			environmentName: null,
		} satisfies Partial<Service>;
	}

	/** How the container runs : placement, networking, resource limits, all optional with a default. */
	static #runtimeColumns(input: NewServiceInput) {
		return {
			...runtimeOptionsFrom(input.runtime),
			authAllowedEmails: [],
			authAllowedGroups: [],
			authAllowedUserIds: [],
			authPaths: input.authPaths ?? [],
			authPathsMode: input.authPathsMode ?? "all",
			authProviders: input.authRequired ? [PASSWORD_METHOD] : [],
			authRequired: input.authRequired ?? false,
			blockedPaths: input.blockedPaths ?? [],
			cpuLimit: input.cpuLimit ?? null,
			dnsResolvable: input.dnsResolvable ?? true,
			memoryLimitMb: input.memoryLimitMb ?? null,
			networkMode: input.networkMode ?? "bridge",
			portProtocol: input.portProtocol ?? "tcp",
			category: input.category ?? null,
			domainPorts: {},
			httpCacheTtl: null,
			icon: input.icon ?? null,
			publishedPorts: input.publishedPorts ?? [],
			stackId: input.stackId ?? null,
			pullPolicy: input.pullPolicy ?? "always",
			replicas: input.replicas ?? 1,
		} satisfies Partial<Service>;
	}

	/**
	 * Up to `limit` services whose name, slug, image, custom domain or git URL
	 * matches `q`, newest first, for global search.
	 */
	static async search(q: string, limit: number): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				searchCondition(q, [
					service.name,
					service.slug,
					service.image,
					service.gitUrl,
				]),
			)
			.orderBy(desc(service.createdAt))
			.limit(limit);
		return rows.map((row) => new ServiceDTO(row));
	}

	/**
	 * Inserts a new service row as pending and stopped, with cron, auto-rollback
	 * and status checks off and uptime checks and image scanning on. Nothing is
	 * deployed.
	 */
	static async create(input: NewServiceInput): Promise<ServiceDTO> {
		const now = new Date();
		const row: Service = {
			...ServiceDTO.#buildColumns(input),
			...ServiceDTO.#runtimeColumns(input),
			...ServiceDTO.#gitTriggerColumns(input),
			...NEW_SERVICE_VERSION_COLUMNS,
			autoRollback: false,
			containerId: null,
			containerPort: input.containerPort,
			createdAt: now,
			cronEnabled: false,
			cronLastRunAt: null,
			cronSchedule: null,
			currentStatus: "pending",
			errorsDismissedAt: null,
			errorsDismissedByDeploymentId: null,
			customSslCertEnc: null,
			customSslKeyEnc: null,
			defaultDomainEnabled: true,
			domains: input.domains ?? [],
			primaryDomain: input.domains?.[0] ?? null,
			desiredState: "stopped",
			envVars: input.envVars,
			secretEnvKeys: input.secretEnvKeys ?? [],
			healthcheckCommand: input.healthcheckCommand ?? null,
			healthcheckDisabled: input.healthcheckDisabled ?? false,
			healthcheckIntervalSeconds: input.healthcheckIntervalSeconds ?? null,
			healthcheckRetries: input.healthcheckRetries ?? null,
			healthcheckStartPeriodSeconds:
				input.healthcheckStartPeriodSeconds ?? null,
			healthcheckTimeoutSeconds: input.healthcheckTimeoutSeconds ?? null,
			id: crypto.randomUUID(),
			image: input.image,
			imageScanEnabled: true,
			name: input.name,
			requireStatusChecks: false,
			requiredStatusChecks: [],
			restartPolicy: input.restartPolicy,
			slug: input.slug,
			swarmServiceId: null,
			tag: input.tag,
			tracesEnabled: false,
			uptimeEnabled: input.uptimeEnabled ?? !isDatabaseImage(input.image),
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(service).values(row);
		return new ServiceDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: ServiceUpdateInput): Promise<void> {
		await db.update(service).set(input).where(eq(service.id, this.row.id));
		Object.assign(this.row, input);
	}

	/**
	 * Hides every error up to now from the Observability tab, recording which
	 * deployment (if any) triggered the dismissal.
	 */
	async dismissErrors(deploymentId: string | null): Promise<void> {
		await this.update({
			errorsDismissedAt: new Date(),
			errorsDismissedByDeploymentId: deploymentId,
		});
	}

	/**
	 * Clears a container or swarm service reference that no longer exists on the
	 * host, resetting the service to pending and stopped so it can be redeployed.
	 */
	async resolveOrphan(): Promise<void> {
		await this.update({
			containerId: null,
			currentStatus: "pending",
			desiredState: "stopped",
			swarmServiceId: null,
		});
	}

	/**
	 * Row-only delete : doesn't remove the container, callers must do that first.
	 */
	async delete(): Promise<void> {
		await db.delete(service).where(eq(service.id, this.row.id));
	}

	/** The service's id. */
	get id(): string {
		return this.row.id;
	}
	/** The id of the user who created the service. */
	get userId(): string {
		return this.row.userId;
	}
	/** The service's display name. */
	get name(): string {
		return this.row.name;
	}
	/**
	 * The unique slug, used as the `<slug>.<baseDomain>` subdomain and the
	 * internal hostname.
	 */
	get slug(): string {
		return this.row.slug;
	}
	/** The image repository, without the tag. */
	get image(): string {
		return this.row.image;
	}
	/** The image tag to deploy. */
	get tag(): string {
		return this.row.tag;
	}
	/**
	 * The live container's id in standalone mode, null when not deployed or under
	 * swarm.
	 */
	get containerId(): string | null {
		return this.row.containerId;
	}
	/** The port the app listens on inside the container. */
	get containerPort(): number {
		return this.row.containerPort;
	}
	/** The command the container runs with instead of the image's own, or null for the image's. */
	get command(): string[] | null {
		return this.row.command;
	}
	/** The service's environment variables, empty when none are stored. */
	get envVars(): Record<string, string> {
		return this.row.envVars ?? {};
	}
	/** Env var names the owner marked secret: redacted wherever the service is exported, whatever their name. */
	get secretEnvKeys(): string[] {
		return this.row.secretEnvKeys;
	}
	/** The container healthcheck command, if one is set. */
	get healthcheckCommand(): string | null {
		return this.row.healthcheckCommand;
	}

	/** Whether every healthcheck is turned off: the image's, Homerun's generated one and the post-deploy readiness probe. */
	get healthcheckDisabled(): boolean {
		return this.row.healthcheckDisabled;
	}

	/** Seconds between healthcheck probes, null for the default. */
	get healthcheckIntervalSeconds(): number | null {
		return this.row.healthcheckIntervalSeconds;
	}

	/** Consecutive failed probes before unhealthy, null for the default. */
	get healthcheckRetries(): number | null {
		return this.row.healthcheckRetries;
	}

	/** Grace period in seconds before failed probes count, null for the default. */
	get healthcheckStartPeriodSeconds(): number | null {
		return this.row.healthcheckStartPeriodSeconds;
	}

	/** Seconds a single probe may run, null for the default. */
	get healthcheckTimeoutSeconds(): number | null {
		return this.row.healthcheckTimeoutSeconds;
	}

	/** The Docker restart policy. */
	get restartPolicy(): string {
		return this.row.restartPolicy;
	}
	/** The CPU limit in cores, null for unlimited. */
	get cpuLimit(): string | null {
		return this.row.cpuLimit;
	}
	/** The memory limit in MB, null for unlimited. */
	get memoryLimitMb(): number | null {
		return this.row.memoryLimitMb;
	}
	/** The private registry to pull the image from, if any. */
	get registryUrl(): string | null {
		return this.row.registryUrl;
	}
	/** The username for the private registry, if any. */
	get registryUsername(): string | null {
		return this.row.registryUsername;
	}
	/**
	 * The encrypted registry password, still encrypted : decrypt it only for a
	 * pull.
	 */
	get registryPasswordEnc(): string | null {
		return this.row.registryPasswordEnc;
	}
	/** Whether the user wants the service running or stopped. */
	get desiredState(): Service["desiredState"] {
		return this.row.desiredState;
	}
	/** The last observed state of the service's container. */
	get currentStatus(): Service["currentStatus"] {
		return this.row.currentStatus;
	}
	/**
	 * When the image is pulled before a deploy : always, only if missing, or
	 * never.
	 */
	get pullPolicy(): PullPolicy {
		return this.row.pullPolicy;
	}
	/** Errors from before this time are hidden on the Observability tab. */
	get errorsDismissedAt(): Date | null {
		return this.row.errorsDismissedAt;
	}
	/** The stack the service belongs to, null when ungrouped. */
	get stackId(): string | null {
		return this.row.stackId;
	}
	/**
	 * Whether Traefik routes a public hostname to the service; false keeps it
	 * internal-only.
	 */
	get dnsResolvable(): boolean {
		return this.row.dnsResolvable;
	}
	/** Whether scheduled redeploys are on. */
	get cronEnabled(): boolean {
		return this.row.cronEnabled;
	}
	/** The cron expression for scheduled redeploys, if set. */
	get cronSchedule(): string | null {
		return this.row.cronSchedule;
	}
	/** The service's own hostnames, routed alongside (or instead of) its default one. */
	get domains(): string[] {
		return this.row.domains;
	}
	/** Whether the default `<slug>.<baseDomain>` hostname is still routed. */
	get defaultDomainEnabled(): boolean {
		return this.row.defaultDomainEnabled;
	}
	/** The hostname chosen as the service's main link, if one was picked. */
	get primaryDomain(): string | null {
		return this.row.primaryDomain;
	}
	/**
	 * The encrypted custom TLS certificate for the custom domain, if uploaded.
	 */
	get customSslCertEnc(): string | null {
		return this.row.customSslCertEnc;
	}
	/**
	 * The encrypted custom TLS private key for the custom domain, if uploaded.
	 */
	get customSslKeyEnc(): string | null {
		return this.row.customSslKeyEnc;
	}
	/** When the last scheduled redeploy ran, null if never. */
	get cronLastRunAt(): Date | null {
		return this.row.cronLastRunAt;
	}
	/** Whether the per-app login wall guards the service. */
	get authRequired(): boolean {
		return this.row.authRequired;
	}
	/** The sign-in providers the login wall accepts. */
	get authProviders(): string[] {
		return this.row.authProviders;
	}
	/** User ids allowed through the login wall. */
	get authAllowedUserIds(): string[] {
		return this.row.authAllowedUserIds;
	}
	/** Email addresses allowed through the login wall. */
	get authAllowedEmails(): string[] {
		return this.row.authAllowedEmails;
	}
	/** Identity provider groups allowed through the login wall. */
	get authAllowedGroups(): string[] {
		return this.row.authAllowedGroups;
	}

	/** Which paths the login wall covers: all of them, only those matching `authPaths`, or all but those. */
	get authPathsMode(): AuthPathsMode {
		return this.row.authPathsMode;
	}
	/** The path patterns `authPathsMode` applies to. */
	get authPaths(): string[] {
		return this.row.authPaths;
	}
	/** Path patterns Traefik answers with a 403 instead of passing them to the app. */
	get blockedPaths(): string[] {
		return this.row.blockedPaths;
	}

	/** The login wall every pull request preview of this service gets, independent of the service's own wall. */
	get previewAccessPolicy(): {
		authAllowedEmails: string[];
		authAllowedGroups: string[];
		authAllowedUserIds: string[];
		authProviders: string[];
		authRequired: boolean;
	} {
		return {
			authAllowedEmails: this.row.previewAuthAllowedEmails,
			authAllowedGroups: this.row.previewAuthAllowedGroups,
			authAllowedUserIds: this.row.previewAuthAllowedUserIds,
			authProviders: this.row.previewAuthProviders,
			authRequired: this.row.previewAuthRequired,
		};
	}
	/** Whether the service deploys a registry image or builds from a git repo. */
	get buildSource(): Service["buildSource"] {
		return this.row.buildSource;
	}
	/** The git repository to build from, for git-built services. */
	get gitUrl(): string | null {
		return this.row.gitUrl;
	}
	/** The branch or tag to build. */
	get gitRef(): string | null {
		return this.row.gitRef;
	}
	/** The configured git provider the repo was picked from, null for a pasted URL. */
	get gitProviderId(): string | null {
		return this.row.gitProviderId;
	}
	/** The repo's path on its provider (`owner/name`, or a GitLab group path). */
	get gitRepo(): string | null {
		return this.row.gitRepo;
	}
	/** Whether a push to the service's branch deploys it. */
	get autoDeployOnPush(): boolean {
		return this.row.autoDeployOnPush;
	}
	/** The provider's id for the push webhook Homerun registered, null when none is. */
	get gitWebhookId(): string | null {
		return this.row.gitWebhookId;
	}
	/** The encrypted secret the push webhook signs its deliveries with. */
	get gitWebhookSecretEnc(): string | null {
		return this.row.gitWebhookSecretEnc;
	}
	/** Why registering the push webhook last failed, null when it didn't. */
	get gitWebhookError(): string | null {
		return this.row.gitWebhookError;
	}
	/** The bake file path relative to the build context, if not `docker-bake.hcl`. */
	get gitBakeFile(): string | null {
		return this.row.gitBakeFile;
	}
	/** The bake target or single-target group to build, if not `default`. */
	get gitBuildTarget(): string | null {
		return this.row.gitBuildTarget;
	}
	/** The build context directory inside the repo, if not the root. */
	get gitBuildContext(): string | null {
		return this.row.gitBuildContext;
	}
	/** How a git service is built: its Dockerfile, a Docker Bake target, or a Nixpacks, Railpack or buildpacks builder. */
	get gitBuildMethod(): BuildMethod {
		return this.row.gitBuildMethod;
	}
	/** The Dockerfile path relative to the build context, if not `Dockerfile`. */
	get gitDockerfilePath(): string | null {
		return this.row.gitDockerfilePath;
	}
	/** The registry used as a build layer cache, null for uncached builds. */
	get buildCacheRegistryId(): string | null {
		return this.row.buildCacheRegistryId;
	}

	/** Whether git builds cache their layers in Homerun's own registry. */
	get buildCacheBuiltin(): boolean {
		return this.row.buildCacheBuiltin;
	}
	/** The remote host builds run on, null to build locally. */
	get buildServerRemoteHostId(): string | null {
		return this.row.buildServerRemoteHostId;
	}
	/** The desired replica count, only used in swarm mode. */
	get replicas(): number {
		return this.row.replicas;
	}
	/**
	 * The Docker Swarm service id when deployed in swarm mode, otherwise null.
	 */
	get swarmServiceId(): string | null {
		return this.row.swarmServiceId;
	}

	/** Whether uptime probes run against the service. */
	get uptimeEnabled(): boolean {
		return this.row.uptimeEnabled;
	}
	/**
	 * Whether the container uses the shared bridge networks or the host's network
	 * namespace.
	 */
	get networkMode(): Service["networkMode"] {
		return this.row.networkMode;
	}
	/** What kind of app this is (a template category like `database`), for its icon and grouping; null when unset. */
	get category(): Service["category"] {
		return this.row.category;
	}
	/** Seconds Traefik caches this service's responses for, per session; null when caching is off. */
	get httpCacheTtl(): Service["httpCacheTtl"] {
		return this.row.httpCacheTtl;
	}
	/** A bundled template icon file name or an uploaded `data:image/...` URL; null for the category's generic icon. */
	get icon(): Service["icon"] {
		return this.row.icon;
	}
	/** Per custom domain, the container port Traefik routes it to instead of `containerPort`. */
	get domainPorts(): Service["domainPorts"] {
		return this.row.domainPorts;
	}
	/** Host ports published straight to the container, bypassing Traefik. */
	get publishedPorts(): Service["publishedPorts"] {
		return this.row.publishedPorts;
	}
	/** Which protocol(s) the container port is exposed under. */
	get portProtocol(): Service["portProtocol"] {
		return this.row.portProtocol;
	}
	/** Whether the service's images are vulnerability-scanned. */
	get imageScanEnabled(): boolean {
		return this.row.imageScanEnabled;
	}
}
