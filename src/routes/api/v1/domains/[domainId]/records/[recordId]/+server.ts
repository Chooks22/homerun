import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { dnsRecordApiJson } from "#lib/server/infrastructure-api-json.js";
import { parseRecordForm } from "#lib/server/validation/dns-forms.js";
import {
	recordFormData,
	updateDnsRecordApiBody,
} from "#lib/server/validation/infrastructure-api.js";
import type { DnsRecord } from "#lib/services/dns-providers/types.js";
import { DomainDnsService } from "#lib/services/domain-dns.service.js";

const logger = new Logger("DNS");

/** A thrown provider error as a message. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The domain and its record `recordId` as the provider lists it, or the response refusing the request. */
async function findRecord(
	domainId: string,
	recordId: string,
): Promise<
	| { domain: DomainDTO; record: DnsRecord & { managed: boolean } }
	| { response: Response }
> {
	const domain = await DomainDTO.get(domainId);
	if (!domain) {
		return { response: apiError("Not found", 404) };
	}
	try {
		const record = (await DomainDnsService.records(domain)).find(
			(candidate) => candidate.id === recordId,
		);
		return record
			? { domain, record }
			: { response: apiError("Not found", 404) };
	} catch (error) {
		return { response: apiError(message(error)) };
	}
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await findRecord(params.domainId, params.recordId);
	if ("response" in found) {
		return found.response;
	}
	return Response.json(dnsRecordApiJson(found.domain.id, found.record));
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await findRecord(params.domainId, params.recordId);
	if ("response" in found) {
		return found.response;
	}
	const body = await readApiBody(request, updateDnsRecordApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { domain, record } = found;
	const parsed = parseRecordForm(
		recordFormData({
			content: record.content,
			name: record.name,
			priority: record.priority,
			ttl: record.ttl,
			type: record.type,
			...body.data,
		}),
		domain.name,
	);
	if (parsed.error !== null) {
		return apiError(parsed.error);
	}
	try {
		const updated = await DomainDnsService.updateRecord(
			domain,
			record.id,
			parsed.value,
		);
		logger.info(
			`DNS record updated: ${parsed.value.type} ${parsed.value.name} user=${caller.userId}`,
		);
		return Response.json(
			dnsRecordApiJson(domain.id, { ...updated, managed: record.managed }),
		);
	} catch (error) {
		return apiError(message(error));
	}
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await findRecord(params.domainId, params.recordId);
	if ("response" in found) {
		return found.response;
	}
	try {
		await DomainDnsService.deleteRecord(found.domain, found.record.id);
	} catch (error) {
		return apiError(message(error));
	}
	logger.info(
		`DNS record deleted in ${found.domain.name} user=${caller.userId}`,
	);
	return new Response(null, { status: 204 });
};
