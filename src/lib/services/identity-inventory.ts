import type { Inventory } from "#lib/iac/generate.js";
import {
	oauthProviderApiJson,
	userApiJson,
} from "#lib/server/identity-api-json.js";
import { OauthProviderConfigService } from "#lib/services/oauth-provider-config.service.js";
import { UserService } from "#lib/services/user.service.js";
import { SERVICE_ACCOUNT } from "#lib/user-types.js";

/** The people's accounts (service accounts have their own type) and the OAuth sign-in providers, in the REST API's shape, for the IaC inventory. */
export async function identityInventory(): Promise<Inventory> {
	const [users, providers] = await Promise.all([
		UserService.listUsers(),
		OauthProviderConfigService.list(),
	]);
	return {
		homerun_oauth_provider: providers.map(oauthProviderApiJson),
		homerun_user: users
			.filter((user) => user.type !== SERVICE_ACCOUNT)
			.map(userApiJson),
	};
}
