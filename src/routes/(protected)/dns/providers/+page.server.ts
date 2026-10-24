import { fail } from "@sveltejs/kit";
import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { parseConnectionForm } from "#lib/server/validation/dns-forms.js";
import { AcmeDnsService } from "#lib/services/acme-dns.service.js";
import {
	DNS_PROVIDERS,
	dnsProviderById,
} from "#lib/services/dns-providers/index.js";

const logger = new Logger("DNS");

export const load = async () => {
	const connections = await DnsConnectionDTO.list();
	return {
		connections: connections.map((connection) => connection.summary()),
		providers: DNS_PROVIDERS.map(({ docsUrl, fields, id, name }) => ({
			docsUrl,
			fields,
			id,
			name,
		})),
	};
};

export const actions = {
	saveConnection: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const existing = await DnsConnectionDTO.get(
			String(formData.get("connectionId") ?? ""),
		);
		const provider = dnsProviderById(
			existing?.summary().provider ?? String(formData.get("provider") ?? ""),
		);
		if (!provider) {
			return fail(400, { error: "Pick a DNS provider." });
		}
		const parsed = parseConnectionForm(formData, provider, existing !== null);
		if (parsed.error !== null) {
			return fail(400, { error: parsed.error });
		}

		const connection =
			existing ??
			(await DnsConnectionDTO.create({
				...parsed.value,
				provider: provider.id,
				userId: locals.user.id,
			}));
		if (existing) {
			await existing.update(parsed.value);
		}
		try {
			const zones = await connection.client().listZones();
			logger.info(
				`DNS connection saved: ${provider.id} "${connection.name}" zones=${zones.length} user=${locals.user.id}`,
			);
			return {
				saved: `${connection.name} is connected: ${zones.length} ${zones.length === 1 ? "zone" : "zones"} visible.`,
			};
		} catch (err) {
			logger.warn(
				`DNS connection saved but its test failed: ${provider.id} "${connection.name}"`,
				err,
			);
			return fail(400, {
				error: `Saved, but ${provider.name} refused the credentials: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	},

	testConnection: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const connection = await DnsConnectionDTO.get(
			String((await request.formData()).get("connectionId") ?? ""),
		);
		if (!connection) {
			return fail(404, { error: "That connection doesn't exist any more." });
		}
		try {
			const zones = await connection.client().listZones();
			return {
				tested: `${connection.name}: ${zones.length} ${zones.length === 1 ? "zone" : "zones"} (${zones
					.slice(0, 5)
					.map((zone) => zone.name)
					.join(", ")}${zones.length > 5 ? ", …" : ""})`,
			};
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	deleteConnection: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const connection = await DnsConnectionDTO.get(
			String((await request.formData()).get("connectionId") ?? ""),
		);
		if (!connection) {
			return fail(404, { error: "That connection doesn't exist any more." });
		}
		await connection.delete();
		void AcmeDnsService.sync();
		logger.info(
			`DNS connection removed: "${connection.name}" user=${locals.user.id}`,
		);
		return { deleted: connection.name };
	},
};
