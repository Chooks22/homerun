import { channelTargetLabel } from "#lib/notification-channel-target.js";
import type {
	BuildCacheRegistry,
	CronJob,
	GitProviderConfig,
	NotificationChannel,
	S3Destination,
	Service,
	StatusPage,
} from "#lib/server/db/schema.js";
import type { StatusPagePick } from "#lib/status-page-members.js";

/**
 * A service as the REST API returns it: the row without its ciphertext
 * columns and its DNS bookkeeping, with whether a registry password and a
 * custom certificate are set.
 */
export function serviceApiJson(row: Service) {
	const {
		customSslCertEnc,
		customSslKeyEnc,
		gitWebhookSecretEnc: _webhookSecret,
		registryPasswordEnc,
		staleDnsHosts: _staleDnsHosts,
		...rest
	} = row;
	return {
		...rest,
		customSslSet: Boolean(customSslCertEnc && customSslKeyEnc),
		registryPasswordSet: Boolean(registryPasswordEnc),
	};
}

/** Whether a service row is an environment of another service (staging, demo...), not one of its previews or its canary. */
export function isEnvironmentRow(row: Service): boolean {
	return (
		row.previewParentId !== null &&
		row.previewPrNumber === null &&
		!row.channelCanary
	);
}

/** An environment of a service, read off the child service that runs it. */
export function serviceEnvironmentApiJson(row: Service) {
	return {
		createdAt: row.createdAt,
		domain:
			row.primaryDomain && row.domains.includes(row.primaryDomain)
				? row.primaryDomain
				: (row.domains[0] ?? null),
		id: row.id,
		name: row.environmentName ?? "",
		ref: (row.buildSource === "git" ? row.gitRef : row.tag) ?? "",
		serviceId: row.previewParentId ?? "",
		slug: row.slug,
	};
}

/** A cron job without its registry password's ciphertext. */
export function cronJobApiJson(row: CronJob) {
	const { registryPasswordEnc, ...rest } = row;
	return { ...rest, registryPasswordSet: Boolean(registryPasswordEnc) };
}

/**
 * Where a channel delivers, without the secret part of it: a webhook URL
 * shows its origin only, a Telegram target its chat id.
 */
export function redactedChannelTarget(
	kind: NotificationChannel["kind"],
	target: string,
): string {
	if (kind === "telegram" || kind === "email" || kind === "browser") {
		return channelTargetLabel(kind, target);
	}
	return URL.canParse(target) ? `${new URL(target).origin}/…` : "…";
}

/** A notification channel without its target, which carries the webhook's token. */
export function notificationChannelApiJson(row: NotificationChannel) {
	const { target, ...rest } = row;
	return { ...rest, targetLabel: redactedChannelTarget(row.kind, target) };
}

/** A backup destination without its secret's ciphertext. */
export function backupDestinationApiJson(row: S3Destination) {
	const { secretAccessKeyEnc, ...rest } = row;
	return { ...rest, secretAccessKeySet: Boolean(secretAccessKeyEnc) };
}

/** A status page with the services a custom page picks. */
export function statusPageApiJson(row: StatusPage, picks: StatusPagePick[]) {
	return { ...row, services: picks };
}

/** A configured git provider without its client secret's ciphertext. */
export function gitProviderApiJson(provider: GitProviderConfig) {
	const { clientSecretEnc, ...rest } = provider;
	return { ...rest, clientSecretSet: Boolean(clientSecretEnc) };
}

/** A build cache registry without its password's ciphertext. */
export function buildCacheRegistryApiJson(row: BuildCacheRegistry) {
	const { passwordEnc, ...rest } = row;
	return { ...rest, passwordSet: Boolean(passwordEnc) };
}

/** A bucket, addressed by its store and name (`<storeId>/<name>` is its id). */
export function bucketApiJson(
	storeId: string,
	name: string,
	expirationDays: number | null,
	isPublic: boolean,
) {
	return {
		expirationDays,
		id: `${storeId}/${name}`,
		name,
		public: isPublic,
		storeId,
	};
}
