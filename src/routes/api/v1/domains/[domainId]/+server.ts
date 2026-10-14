import { DomainDTO } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { updateDomainApiBody } from "#lib/server/validation/infrastructure-api.js";
import {
	DomainSettingsError,
	DomainSettingsService,
} from "#lib/services/domain-settings.service.js";

const logger = new Logger("DNS");

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const domain = await DomainDTO.get(params.domainId);
	return domain ? Response.json(domain.toJSON()) : apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const domain = await DomainDTO.get(params.domainId);
	if (!domain) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateDomainApiBody);
	if ("response" in body) {
		return body.response;
	}
	const blankToNull = (value: string | null | undefined) =>
		value === undefined ? undefined : value || null;
	try {
		await DomainSettingsService.update(domain, {
			autoRecords: body.data.autoRecords,
			connectionId: blankToNull(body.data.connectionId),
			target: blankToNull(body.data.target),
			zoneId: blankToNull(body.data.zoneId),
			zoneName: blankToNull(body.data.zoneName),
		});
	} catch (error) {
		if (error instanceof DomainSettingsError) {
			return apiError(error.message);
		}
		throw error;
	}
	return Response.json(domain.toJSON());
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const domain = await DomainDTO.get(params.domainId);
	if (!domain) {
		return apiError("Not found", 404);
	}
	await domain.delete();
	logger.info(`Domain removed: ${domain.name} user=${caller.userId}`);
	return new Response(null, { status: 204 });
};
