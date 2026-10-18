import { error, fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	parseDomainForm,
	parseRecordForm,
} from "#lib/server/validation/dns-forms.js";
import { DomainDnsService } from "#lib/services/domain-dns.service.js";
import {
	DomainSettingsError,
	DomainSettingsService,
} from "#lib/services/domain-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("DNS");

/** The domain an action works on, redirecting a signed-out caller to sign-in. */
async function actionDomain(
	locals: App.Locals,
	domainId: string,
): Promise<DomainDTO | null> {
	if (!locals.user) {
		redirectToSignIn();
	}
	return await DomainDTO.get(domainId);
}

/** A thrown provider error as a message. */
function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export const load = async ({ params, parent }) => {
	await parent();
	const domain = await DomainDTO.get(params.domainId);
	if (!domain) {
		error(404, "That domain isn't added.");
	}
	const connections = await DnsConnectionDTO.list();
	return {
		baseDomain: config.baseDomain,
		connections: connections.map((connection) => connection.summary()),
		crumbRoot: [{ href: resolve("dns"), label: "DNS" }],
		domain: domain.toJSON(),
		records: domain.connectionId
			? DomainDnsService.records(domain).then(
					(records) => ({ error: null, records }),
					(err: unknown) => ({ error: message(err), records: [] }),
				)
			: Promise.resolve({ error: null, records: [] }),
		target: DomainDnsService.targetOf(domain),
	};
};

export const actions = {
	updateDomain: async ({ locals, params, request }) => {
		const domain = await actionDomain(locals, params.domainId);
		if (!domain) {
			return fail(404, { error: "That domain doesn't exist any more." });
		}
		const parsed = parseDomainForm(await request.formData(), false);
		if (parsed.error !== null) {
			return fail(400, { error: parsed.error });
		}
		const { name: _name, ...rest } = parsed.value;
		try {
			await DomainSettingsService.update(domain, rest);
		} catch (err) {
			if (err instanceof DomainSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { saved: true };
	},

	pointAtServer: async ({ locals, params }) => {
		const domain = await actionDomain(locals, params.domainId);
		if (!domain) {
			return fail(404, { error: "That domain doesn't exist any more." });
		}
		try {
			return {
				pointed: (await DomainDnsService.pointAtServer(domain)).join("; "),
			};
		} catch (err) {
			return fail(400, { error: message(err) });
		}
	},

	saveRecord: async ({ locals, params, request }) => {
		const domain = await actionDomain(locals, params.domainId);
		if (!domain) {
			return fail(404, { error: "That domain doesn't exist any more." });
		}
		const formData = await request.formData();
		const parsed = parseRecordForm(formData, domain.name);
		if (parsed.error !== null) {
			return fail(400, { error: parsed.error });
		}
		const recordId = String(formData.get("recordId") ?? "");
		try {
			if (recordId) {
				await DomainDnsService.updateRecord(domain, recordId, parsed.value);
			} else {
				await DomainDnsService.createRecord(domain, parsed.value);
			}
		} catch (err) {
			return fail(400, { error: message(err) });
		}
		logger.info(
			`DNS record ${recordId ? "updated" : "created"}: ${parsed.value.type} ${parsed.value.name} user=${locals.user?.id}`,
		);
		return { savedRecord: parsed.value.name };
	},

	deleteRecord: async ({ locals, params, request }) => {
		const domain = await actionDomain(locals, params.domainId);
		if (!domain) {
			return fail(404, { error: "That domain doesn't exist any more." });
		}
		try {
			await DomainDnsService.deleteRecord(
				domain,
				String((await request.formData()).get("recordId") ?? ""),
			);
		} catch (err) {
			return fail(400, { error: message(err) });
		}
		logger.info(`DNS record deleted in ${domain.name} user=${locals.user?.id}`);
		return { deletedRecord: true };
	},
};
