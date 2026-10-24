import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DnsManagedRecordDTO } from "#lib/dto/dns-managed-record-dto.js";
import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { parseDomainForm } from "#lib/server/validation/dns-forms.js";
import {
	DomainSettingsError,
	DomainSettingsService,
} from "#lib/services/domain-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("DNS");

export const load = async () => {
	const [domains, connections] = await Promise.all([
		DomainDTO.list(),
		DnsConnectionDTO.list(),
	]);
	const names = new Map(
		connections.map((connection) => [connection.id, connection.summary()]),
	);
	return {
		baseDomain: config.baseDomain,
		connections: connections.map((connection) => connection.summary()),
		domains: await Promise.all(
			domains.map(async (domain) => ({
				...domain.toJSON(),
				connection: domain.connectionId
					? (names.get(domain.connectionId) ?? null)
					: null,
				managedRecords: (await DnsManagedRecordDTO.listForDomain(domain.id))
					.length,
			})),
		),
	};
};

export const actions = {
	addDomain: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const parsed = parseDomainForm(await request.formData(), true);
		if (parsed.error !== null) {
			return fail(400, { error: parsed.error });
		}
		let domainId: string;
		try {
			domainId = (await DomainSettingsService.add(parsed.value, locals.user.id))
				.id;
		} catch (error) {
			if (error instanceof DomainSettingsError) {
				return fail(400, { error: error.message });
			}
			throw error;
		}
		throw redirect(
			303,
			resolve("/(protected)/dns/domains/[domainId]", { domainId }),
		);
	},

	deleteDomain: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const domain = await DomainDTO.get(
			String((await request.formData()).get("domainId") ?? ""),
		);
		if (!domain) {
			return fail(404, { error: "That domain doesn't exist any more." });
		}
		await DomainSettingsService.remove(domain);
		logger.info(`Domain removed: ${domain.name} user=${locals.user.id}`);
		return { deleted: domain.name };
	},
};
