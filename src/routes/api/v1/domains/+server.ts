import { DomainDTO } from "#lib/dto/domain-dto.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { domainApiBody } from "#lib/server/validation/infrastructure-api.js";
import {
	DomainSettingsError,
	DomainSettingsService,
} from "#lib/services/domain-settings.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(
		(await DomainDTO.list()).map((domain) => domain.toJSON()),
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, domainApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		const domain = await DomainSettingsService.add(
			{
				autoRecords: body.data.autoRecords,
				connectionId: body.data.connectionId || null,
				dnsChallenge: body.data.dnsChallenge,
				name: body.data.name,
				target: body.data.target || null,
				zoneId: body.data.zoneId || null,
				zoneName: body.data.zoneName || null,
			},
			caller.userId,
		);
		return Response.json(domain.toJSON(), { status: 201 });
	} catch (error) {
		if (error instanceof DomainSettingsError) {
			return apiError(error.message);
		}
		throw error;
	}
};
