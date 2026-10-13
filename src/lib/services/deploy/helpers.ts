import { config } from "#lib/config.js";
import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import type { ServiceVolumeDTO } from "#lib/dto/service-volume-dto.js";
import type { StackDTO } from "#lib/dto/stack-dto.js";
import {
	type GitCredential,
	hasEmbeddedCredentials,
	providerForGitUrl,
	providerHost,
} from "#lib/git-clone-url.js";
import { DEPLOY_LOG_SCOPE, Logger } from "#lib/logger.js";
import type { GitProviderKind } from "#lib/server/db/schema.js";
import { serviceHostnames } from "#lib/service-domains.js";
import { syncDns } from "../dns.service.ts";
import { GitProviderService } from "../git-provider.service.ts";

const logger = new Logger(DEPLOY_LOG_SCOPE);

export type ServiceMounts = Awaited<
	ReturnType<typeof ServiceVolumeDTO.listForService>
>;

/**
 * Syncs DNS for every hostname a service routes, through
 * whichever DNS provider is configured, after a successful deploy. No-op
 * when the service isn't DNS-resolvable. Appends a result line per hostname
 * to the deployment's log, and logs a warning for any provider failure
 * rather than throwing : DNS sync is best-effort, it never fails the deploy.
 */
export async function syncAutoDns(
	svc: ServiceDTO,
	stack: StackDTO | null,
	dep: DeploymentDTO,
): Promise<void> {
	if (!svc.dnsResolvable) {
		return;
	}
	const hostnames = serviceHostnames(
		svc.toJSON(),
		stack?.slug,
		config.baseDomain,
	);
	const results = await syncDns(hostnames);
	if (results.length > 0) {
		await dep.appendLog(
			results
				.map(
					(result) =>
						`${result.ok ? "DNS" : "DNS failed"} (${result.provider}): ${result.detail}`,
				)
				.join("\n"),
		);
	}
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) {
		logger.warn(
			`DNS sync incomplete: service=${svc.id} ${failed
				.map((result) => `${result.provider}=${result.detail}`)
				.join(" ")}`,
		);
	}
}

/** Shapes a service's resolved volume mounts into the params `DockerService`'s container/swarm create calls expect. */
export function toVolumeParams(mounts: ServiceMounts) {
	return mounts.map((m) => ({
		containerPath: m.mount.toJSON().containerPath,
		readOnly: m.mount.toJSON().readOnly,
		source: m.volumeSource,
	}));
}

/** A connected git provider's login, with the host it serves repositories from. */
export interface ProviderCredential extends GitCredential {
	host: string;
	kind: GitProviderKind;
}

/**
 * The credential `userId`'s connection to git provider `providerId` holds.
 * Null when the provider is gone or disabled, has no known host, the user
 * isn't connected to it, or its token can't be decrypted or refreshed.
 */
export async function resolveProviderCredential(
	providerId: string,
	userId: string,
): Promise<ProviderCredential | null> {
	const settings = await InstanceSettingsDTO.get();
	const provider = settings.gitProviders.find(
		(p) => p.id === providerId && p.enabled,
	);
	const host = provider ? providerHost(provider) : null;
	if (!provider || !host) {
		return null;
	}
	const connection = await GitConnectionDTO.getForUserAndProvider(
		userId,
		provider.id,
	);
	const token = connection
		? await GitProviderService.accessToken(provider, connection)
		: null;
	if (!connection || !token) {
		return null;
	}
	return {
		host,
		kind: provider.kind,
		token,
		username: connection.toJSON().providerUsername || "oauth2",
	};
}

/**
 * Resolves the credential a git build/clone of `gitUrl` should use. Returns
 * null when the URL already embeds credentials, when no enabled git provider
 * matches the host, when the user has no connection to that provider, or
 * when the connection's stored token can't be decrypted : any of those mean
 * the clone is attempted without auth (fine for a public repo).
 */
export async function resolveGitCredential(
	gitUrl: string,
	userId: string,
): Promise<GitCredential | null> {
	if (hasEmbeddedCredentials(gitUrl)) {
		return null;
	}
	const settings = await InstanceSettingsDTO.get();
	const provider = providerForGitUrl(
		gitUrl,
		settings.gitProviders.filter((p) => p.enabled),
	);
	if (!provider) {
		return null;
	}
	const connection = await GitConnectionDTO.getForUserAndProvider(
		userId,
		provider.id,
	);
	if (!connection) {
		return null;
	}
	const token = await GitProviderService.accessToken(provider, connection);
	if (!token) {
		return null;
	}
	return {
		token,
		username: connection.toJSON().providerUsername || "oauth2",
	};
}
