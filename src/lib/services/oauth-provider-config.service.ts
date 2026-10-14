import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import type { InstanceOauthProvider } from "#lib/server/db/schema.js";
import {
	checkOauthProvider,
	type OauthProviderFields,
} from "#lib/server/oauth-provider-form.js";
import { applyAndRebuild } from "#lib/server/validation/instance-settings-form.js";

const logger = new Logger("InstanceSettings");

/** A provider change refused for the caller's input; nothing was saved. */
export class OauthProviderConfigError extends Error {}

/** A stored provider as `checkOauthProvider` takes it, without its secret. */
function asFields(provider: InstanceOauthProvider): OauthProviderFields {
	return {
		clientId: provider.clientId,
		discoveryUrl: provider.discoveryUrl,
		enabled: provider.enabled,
		label: provider.label || provider.name,
		name: provider.name,
		pkce: provider.pkce,
		scopes: provider.scopes,
		signOutOfProvider: provider.signOutOfProvider ?? false,
		tokenAuthMethod: provider.tokenAuthMethod ?? "auto",
	};
}

/**
 * The OAuth sign-in providers (Authentication → Providers), kept in
 * `instance_settings.oauthProviders` and shared by the dashboard and the
 * REST API. Every save checks the provider's discovery document first and
 * then applies the settings and rebuilds auth, so it's live right away.
 */
class OauthProviderConfigServiceClass {
	/** Every configured provider, in the order they were added. */
	async list(): Promise<InstanceOauthProvider[]> {
		return (await InstanceSettingsDTO.get()).toJSON().oauthProviders;
	}

	/** One configured provider by its name, null when there's none. */
	async get(name: string): Promise<InstanceOauthProvider | null> {
		return (await InstanceSettingsDTO.get()).oauthProvider(name);
	}

	/**
	 * Adds a provider.
	 *
	 * @throws {OauthProviderConfigError} When a field is invalid, the name is
	 *   taken or the discovery document can't be fetched.
	 */
	async add(
		fields: OauthProviderFields,
		userId: string,
	): Promise<InstanceOauthProvider> {
		const settings = await InstanceSettingsDTO.get();
		const parsed = await checkOauthProvider(
			fields,
			settings.toJSON().oauthProviders.map((provider) => provider.name),
		);
		if (!parsed.input) {
			throw new OauthProviderConfigError(parsed.error ?? "Invalid provider.");
		}
		await settings.addOauthProvider(parsed.input);
		applyAndRebuild(settings);
		logger.info(
			`OAuth provider added: name=${parsed.input.name} user=${userId}`,
		);
		return settings.oauthProvider(parsed.input.name) as InstanceOauthProvider;
	}

	/**
	 * Changes the fields given and keeps the others; the name can't change
	 * and a missing secret keeps the stored one.
	 *
	 * @throws {OauthProviderConfigError} When it doesn't exist, a field is
	 *   invalid or the discovery document can't be fetched.
	 */
	async update(
		name: string,
		changes: Partial<OauthProviderFields>,
		userId: string,
	): Promise<InstanceOauthProvider> {
		const settings = await InstanceSettingsDTO.get();
		const current = settings.oauthProvider(name);
		if (!current) {
			throw new OauthProviderConfigError("No OAuth provider with that id.");
		}
		const parsed = await checkOauthProvider(
			{ ...asFields(current), ...changes, name },
			settings
				.toJSON()
				.oauthProviders.map((provider) => provider.name)
				.filter((taken) => taken !== name),
		);
		if (!parsed.input) {
			throw new OauthProviderConfigError(parsed.error ?? "Invalid provider.");
		}
		await settings.updateOauthProvider(name, parsed.input);
		applyAndRebuild(settings);
		logger.info(`OAuth provider updated: name=${name} user=${userId}`);
		return settings.oauthProvider(name) as InstanceOauthProvider;
	}

	/** Removes a provider; login walls listing `oauth:<name>` stop offering it. */
	async remove(name: string, userId: string): Promise<void> {
		const settings = await InstanceSettingsDTO.get();
		await settings.deleteOauthProvider(name);
		applyAndRebuild(settings);
		logger.info(`OAuth provider deleted: name=${name} user=${userId}`);
	}
}

export const OauthProviderConfigService = new OauthProviderConfigServiceClass();
