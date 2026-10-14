import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { dnsRecordApiJson } from "#lib/server/infrastructure-api-json.js";
import { parseRecordForm } from "#lib/server/validation/dns-forms.js";
import {
	dnsRecordApiBody,
	recordFormData,
} from "#lib/server/validation/infrastructure-api.js";
import { DomainDnsService } from "#lib/services/domain-dns.service.js";

const logger = new Logger("DNS");

/** A thrown provider error as a message. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const domain = await DomainDTO.get(params.domainId);
	if (!domain) {
		return apiError("Not found", 404);
	}
	try {
		const records = await DomainDnsService.records(domain);
		return Response.json(
			records.map((record) => dnsRecordApiJson(domain.id, record)),
		);
	} catch (error) {
		return apiError(message(error));
	}
};

export const POST = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const domain = await DomainDTO.get(params.domainId);
	if (!domain) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, dnsRecordApiBody);
	if ("response" in body) {
		return body.response;
	}
	const parsed = parseRecordForm(recordFormData(body.data), domain.name);
	if (parsed.error !== null) {
		return apiError(parsed.error);
	}
	try {
		const record = await DomainDnsService.createRecord(domain, parsed.value);
		logger.info(
			`DNS record created: ${parsed.value.type} ${parsed.value.name} user=${caller.userId}`,
		);
		return Response.json(
			dnsRecordApiJson(domain.id, { ...record, managed: false }),
			{ status: 201 },
		);
	} catch (error) {
		return apiError(message(error));
	}
};
