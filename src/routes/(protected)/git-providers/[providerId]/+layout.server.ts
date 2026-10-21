import { error } from "@sveltejs/kit";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { can } from "#lib/permissions.js";
import { browserOrigin } from "#lib/server/canonical-origin.js";
import { GitProviderConfigService } from "#lib/services/git-provider-config.service.js";
import { resolve } from "$app/paths";

export const load = async ({ locals, params, parent, request, url }) => {
	const { user } = await parent();
	const provider = await GitProviderConfigService.get(params.providerId);
	if (!provider) {
		error(404, "That git provider doesn't exist.");
	}
	const connection = await GitConnectionDTO.getForUserAndProvider(
		user.id,
		provider.id,
	);
	const returnTo = resolve("/(protected)/git-providers/[providerId]", {
		providerId: provider.id,
	});

	return {
		callbackUrl: `${browserOrigin(request, url)}/api/v1/git-providers/${provider.id}/callback`,
		canWrite: can(locals.permissions, "git-providers", "write"),
		connectUrl: `/api/v1/git-providers/${provider.id}/connect?${new URLSearchParams({ returnTo })}`,
		connection: connection
			? {
					connectedAt: connection.createdAt,
					expiresAt: connection.expiresAt,
					updatedAt: connection.updatedAt,
					username: connection.providerUsername,
				}
			: null,
		provider: {
			baseUrl: provider.baseUrl,
			clientId: provider.clientId,
			enabled: provider.enabled,
			id: provider.id,
			kind: provider.kind,
			name: provider.name,
		},
	};
};
