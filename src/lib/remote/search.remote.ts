import { z } from "zod";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { NotificationChannelDTO } from "#lib/dto/notification-channel-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StatusPageDTO } from "#lib/dto/status-page-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { TemplateDTO } from "#lib/dto/template-dto.js";
import { can, mayVisit } from "#lib/permissions.js";
import {
	groupResults,
	matchesSearch,
	SEARCH_GROUP_LIMIT,
	SEARCH_MAX_LENGTH,
	SEARCH_MIN_LENGTH,
	type SearchGroup,
	type SearchResult,
} from "#lib/search.js";
import { requireUser } from "#lib/server/remote-auth.js";
import { UserService } from "#lib/services/user.service.js";
import { resolve } from "$app/paths";
import { getRequestEvent, query } from "$app/server";

function withQuery(path: string, q: string): string {
	return `${path}?${new URLSearchParams({ q })}`;
}

/**
 * Global search over the instance's services, stacks, templates, cron jobs and
 * status pages, each mapped to a result linking to its page.
 */
async function searchWorkspace(
	q: string,
	limit: number,
): Promise<SearchResult[]> {
	const [services, stacks, templates, cronJobs, statusPages] =
		await Promise.all([
			ServiceDTO.search(q, limit),
			StackDTO.search(q, limit),
			TemplateDTO.search(q, limit),
			CronJobDTO.search(q, limit),
			StatusPageDTO.search(q, limit),
		]);

	return [
		...services
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.primaryDomain ?? row.gitUrl ?? `${row.image}:${row.tag}`,
				href: resolve("/(protected)/services/[serviceId]", {
					serviceId: row.id,
				}),
				id: row.id,
				kind: "service" as const,
				label: row.name,
			})),
		...stacks
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.description ?? row.slug,
				href: resolve("/(protected)/stacks/[stackId]", {
					stackId: row.id,
				}),
				id: row.id,
				kind: "stack" as const,
				label: row.name,
			})),
		...templates
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: `${row.image}:${row.tag}`,
				href: resolve("/(protected)/templates/[templateId]", {
					templateId: row.id,
				}),
				id: row.id,
				kind: "template" as const,
				label: row.name,
			})),
		...cronJobs
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.schedule,
				href: resolve("/(protected)/cron-jobs/[cronJobId]", {
					cronJobId: row.id,
				}),
				id: row.id,
				kind: "cronJob" as const,
				label: row.name,
			})),
		...statusPages
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: `/status/${row.slug}`,
				href: resolve("/(protected)/status-pages/[statusPageId]", {
					statusPageId: row.id,
				}),
				id: row.id,
				kind: "statusPage" as const,
				label: row.name,
			})),
	];
}

/**
 * Global search over the instance's remote hosts, storage volumes, S3
 * destinations, build cache registries and the user's own notification channels, each mapped to a result
 * linking to its page.
 */
async function searchInfrastructure(
	userId: string,
	q: string,
	limit: number,
): Promise<SearchResult[]> {
	const [remoteHosts, volumes, s3Destinations, registries, channels] =
		await Promise.all([
			RemoteHostDTO.search(q, limit),
			StorageVolumeDTO.search(q, limit),
			S3DestinationDTO.search(q, limit),
			BuildCacheRegistryDTO.search(q, limit),
			NotificationChannelDTO.search(userId, q, limit),
		]);

	return [
		...remoteHosts
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.agentUrl ?? row.dockerHost,
				href: resolve("/(protected)/remote-hosts/[hostId]", { hostId: row.id }),
				id: row.id,
				kind: "remoteHost" as const,
				label: row.name,
			})),
		...volumes
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.source,
				href: resolve("/(protected)/storage/[volumeId]", { volumeId: row.id }),
				id: row.id,
				kind: "storageVolume" as const,
				label: row.name,
			})),
		...s3Destinations
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: `${row.bucket} · ${row.endpoint}`,
				href: withQuery(resolve("s3-destinations"), row.name),
				id: row.id,
				kind: "s3Destination" as const,
				label: row.name,
			})),
		...registries
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.registryUrl,
				href: resolve("/(protected)/build-cache-registries/[registryId]", {
					registryId: row.id,
				}),
				id: row.id,
				kind: "buildCacheRegistry" as const,
				label: row.name,
			})),
		...channels
			.map((dto) => dto.toJSON())
			.map((row) => ({
				detail: row.kind,
				href: resolve("notifications/settings/channels"),
				id: row.id,
				kind: "notificationChannel" as const,
				label: row.name,
			})),
	];
}

/**
 * Global search over instance-level configuration : git providers, plus users
 * and sign-in OAuth providers for callers who may read Users.
 */
async function searchInstance(
	q: string,
	limit: number,
	canReadUsers: boolean,
): Promise<SearchResult[]> {
	const [users, settings] = await Promise.all([
		canReadUsers ? UserService.searchUsers(q, limit) : Promise.resolve([]),
		InstanceSettingsDTO.get(),
	]);
	const oauthProviders = canReadUsers ? settings.toJSON().oauthProviders : [];

	return [
		...users.map((row) => ({
			detail: row.role ? `${row.email} · ${row.role}` : row.email,
			href: withQuery(resolve("users"), row.email),
			id: row.id,
			kind: "user" as const,
			label: row.name,
		})),
		...settings.gitProviders
			.filter((p) => matchesSearch(q, [p.name, p.kind, p.baseUrl]))
			.slice(0, limit)
			.map((p) => ({
				detail: p.baseUrl ?? p.kind,
				href: resolve("git-providers"),
				id: p.id,
				kind: "gitProvider" as const,
				label: p.name,
			})),
		...oauthProviders
			.filter((p) => matchesSearch(q, [p.name, p.label, p.discoveryUrl]))
			.slice(0, limit)
			.map((p) => ({
				detail: p.discoveryUrl,
				href: resolve("/(protected)/authentication/[providerId]", {
					providerId: p.name,
				}),
				id: p.name,
				kind: "authProvider" as const,
				label: p.label || p.name,
			})),
	];
}

export const searchContent = query(
	z.string().trim().min(SEARCH_MIN_LENGTH).max(SEARCH_MAX_LENGTH),
	async (q): Promise<SearchGroup[]> => {
		const user = requireUser();
		const { permissions } = getRequestEvent().locals;
		const groups = await Promise.all([
			searchWorkspace(q, SEARCH_GROUP_LIMIT),
			searchInfrastructure(user.id, q, SEARCH_GROUP_LIMIT),
			searchInstance(q, SEARCH_GROUP_LIMIT, can(permissions, "users")),
		]);
		return groupResults(
			groups.flat().filter((result) => mayVisit(permissions, result.href)),
		);
	},
);
