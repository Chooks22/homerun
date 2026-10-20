import { error } from "@sveltejs/kit";
import { z } from "zod";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import { requirePermission, requireUser } from "#lib/server/remote-auth.js";
import {
	GitProviderService,
	type GitRepo,
} from "#lib/services/git-provider.service.js";
import { command, query } from "$app/server";

const logger = new Logger("GitProviders");

/**
 * Looks up a configured git provider and the user's connection to it.
 *
 * @throws A 404 error when the provider doesn't exist, or 400 when the user
 * hasn't connected to it.
 */
async function resolveConnection(providerId: string, userId: string) {
	const settings = await InstanceSettingsDTO.get();
	const provider = settings.gitProviders.find((p) => p.id === providerId);
	if (!provider) {
		error(404, "Git provider not found.");
	}

	const connection = await GitConnectionDTO.getForUserAndProvider(
		userId,
		provider.id,
	);
	if (!connection) {
		error(400, "Not connected to this provider.");
	}

	return { connection, provider };
}

export const listProviderRepos = query(
	z.string(),
	async (providerId): Promise<GitRepo[]> => {
		const user = requirePermission("services", "read");
		const { connection, provider } = await resolveConnection(
			providerId,
			user.id,
		);

		try {
			return await GitProviderService.listRepos(provider, connection);
		} catch (err) {
			logger.warn(`Repo listing failed: provider=${provider.id}`, err);
			error(502, "Couldn't list repos.");
		}
	},
);

export const listRepoBranches = query(
	z.object({ providerId: z.string(), repo: z.string() }),
	async ({ providerId, repo }): Promise<string[]> => {
		const user = requirePermission("services", "read");
		const { connection, provider } = await resolveConnection(
			providerId,
			user.id,
		);
		try {
			return await GitProviderService.listBranches(provider, connection, repo);
		} catch (err) {
			logger.warn(
				`Branch listing failed: provider=${provider.id} repo=${repo}`,
				err,
			);
			error(502, "Couldn't list branches.");
		}
	},
);

export const hasDockerfile = query(
	z.object({ providerId: z.string(), ref: z.string(), repo: z.string() }),
	async ({ providerId, ref, repo }): Promise<boolean> => {
		const user = requirePermission("services", "read");
		const { connection, provider } = await resolveConnection(
			providerId,
			user.id,
		);
		return await GitProviderService.hasDockerfile(
			provider,
			connection,
			repo,
			ref,
		);
	},
);

/**
 * Drops the caller's own connection to a git provider. It's their personal
 * link, so it needs no permission on Git providers, which only governs the
 * instance's provider list.
 */
export const disconnectGitProvider = command(
	z.string(),
	async (providerId): Promise<void> => {
		const user = requireUser();
		const connection = await GitConnectionDTO.getForUserAndProvider(
			user.id,
			providerId,
		);
		if (connection) {
			await connection.delete();
			logger.info(
				`Git provider disconnected: provider=${providerId} user=${user.id}`,
			);
		}
	},
);
