import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
} from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { service } from "#lib/server/db/schema.js";
import { ServiceDTO } from "./service-dto";

/**
 * The `service` finders behind push polling, webhook retries and pull request
 * previews, kept apart from `ServiceDTO` so that one stays readable. It
 * extends `ServiceDTO` only to build its rows, every result is used as a
 * plain `ServiceDTO`.
 */
export class ServiceGitDTO extends ServiceDTO {
	/**
	 * Every git service that deploys on push and needs its branch polled:
	 * polling is turned on for it, or Homerun couldn't register its webhook.
	 * Pull request previews are never polled, and neither is a service with
	 * release channels on (branch pushes feed its canary, which is polled
	 * instead, never having a webhook of its own). A service's environments
	 * have no webhook of their own either: each is polled on its branch when
	 * its parent's webhook isn't there to deploy it, or polling is on.
	 */
	static async listPushPollable(): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.buildSource, "git"),
					eq(service.autoDeployOnPush, true),
					eq(service.channelsEnabled, false),
					isNull(service.previewPrNumber),
					or(eq(service.gitPollEnabled, true), isNull(service.gitWebhookId)),
				),
			);
		const environmentParents = [
			...new Set(
				rows.flatMap((row) =>
					row.previewParentId && !row.channelCanary
						? [row.previewParentId]
						: [],
				),
			),
		];
		const pollingParents =
			environmentParents.length === 0
				? new Set<string>()
				: new Set(
						(
							await db
								.select({
									gitPollEnabled: service.gitPollEnabled,
									gitWebhookId: service.gitWebhookId,
									id: service.id,
								})
								.from(service)
								.where(inArray(service.id, environmentParents))
						)
							.filter((parent) => parent.gitPollEnabled || !parent.gitWebhookId)
							.map((parent) => parent.id),
					);
		return rows
			.filter(
				(row) =>
					!row.previewParentId ||
					row.channelCanary ||
					pollingParents.has(row.previewParentId),
			)
			.map((row) => new ServiceGitDTO(row));
	}

	/** The services listed under each of `parentIds` (its release channel canary, environments and pull request previews), the canary first then newest pull request first, keyed by parent id. */
	static async listPreviewsOf(
		parentIds: string[],
	): Promise<Map<string, ServiceDTO[]>> {
		const byParent = new Map<string, ServiceDTO[]>();
		if (parentIds.length === 0) {
			return byParent;
		}
		const rows = await db
			.select()
			.from(service)
			.where(inArray(service.previewParentId, parentIds))
			.orderBy(desc(service.previewPrNumber));
		for (const row of rows) {
			const parentId = row.previewParentId ?? "";
			byParent.set(parentId, [
				...(byParent.get(parentId) ?? []),
				new ServiceGitDTO(row),
			]);
		}
		return byParent;
	}

	/** The pull request previews of a service, newest pull request first. */
	static async listPreviews(parentId: string): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.previewParentId, parentId),
					isNotNull(service.previewPrNumber),
				),
			)
			.orderBy(desc(service.previewPrNumber));
		return rows.map((row) => new ServiceGitDTO(row));
	}

	/** The environments created on a service (staging, demo...), neither its pull request previews nor its canary, by name. */
	static async listEnvironments(parentId: string): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.previewParentId, parentId),
					isNull(service.previewPrNumber),
					eq(service.channelCanary, false),
				),
			)
			.orderBy(asc(service.environmentName));
		return rows.map((row) => new ServiceGitDTO(row));
	}

	/** Every service Homerun manages under a parent: its pull request previews and its release channel canary. */
	static async listChildren(parentId: string): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(eq(service.previewParentId, parentId));
		return rows.map((row) => new ServiceGitDTO(row));
	}

	/** The release channel canary of a service, null when it has none. */
	static async getCanary(parentId: string): Promise<ServiceDTO | null> {
		const [row] = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.previewParentId, parentId),
					eq(service.channelCanary, true),
				),
			)
			.limit(1);
		return row ? new ServiceGitDTO(row) : null;
	}

	/** The preview of pull request `prNumber` on a service, null when there's none. */
	static async getPreview(
		parentId: string,
		prNumber: number,
	): Promise<ServiceDTO | null> {
		const [row] = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.previewParentId, parentId),
					eq(service.previewPrNumber, prNumber),
				),
			)
			.limit(1);
		return row ? new ServiceGitDTO(row) : null;
	}

	/**
	 * The git services a user owns on one provider whose webhook isn't
	 * registered although deploy on push or previews want one, to retry once
	 * that user reconnects the provider.
	 */
	static async listAwaitingWebhook(
		userId: string,
		providerId: string,
	): Promise<ServiceDTO[]> {
		const rows = await db
			.select()
			.from(service)
			.where(
				and(
					eq(service.userId, userId),
					eq(service.gitProviderId, providerId),
					eq(service.buildSource, "git"),
					isNull(service.gitWebhookId),
					isNull(service.previewParentId),
					or(
						eq(service.autoDeployOnPush, true),
						eq(service.previewsEnabled, true),
						eq(service.channelsEnabled, true),
					),
				),
			);
		return rows.map((row) => new ServiceGitDTO(row));
	}
}
