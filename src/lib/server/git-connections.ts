import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import type { GitProviderKind } from "#lib/server/db/schema.js";

/** One git provider the user has connected, as the repo pickers take it. */
export interface ConnectedGitProvider {
	id: string;
	kind: GitProviderKind;
	name: string;
	providerUsername: string;
}

/** The configured git providers this user has actually connected, a removed provider's stale connection left out. */
export async function connectedGitProviders(
	userId: string,
): Promise<ConnectedGitProvider[]> {
	const [settings, connections] = await Promise.all([
		InstanceSettingsDTO.get(),
		GitConnectionDTO.listForUser(userId),
	]);
	const providersById = new Map(settings.gitProviders.map((p) => [p.id, p]));
	return connections
		.filter((c) => providersById.has(c.providerId))
		.map((c) => ({
			id: c.providerId,
			kind: c.providerKind,
			name: providersById.get(c.providerId)?.name ?? c.providerKind,
			providerUsername: c.providerUsername,
		}));
}
