import { Logger } from "#lib/logger.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { versionedService } from "#lib/server/service-version-api.js";
import { servicePinApiBody } from "#lib/server/validation/operations-api.js";
import { ImageVersionService } from "#lib/services/image-version.service.js";

const logger = new Logger("API");

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	return Response.json(await ImageVersionService.findPinCandidates(found.svc));
};

export const POST = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	const body = await readApiBody(request, servicePinApiBody);
	if ("response" in body) {
		return body.response;
	}
	try {
		await ImageVersionService.pin(found.svc, body.data.tag, {
			local: body.data.local,
		});
	} catch (err) {
		return apiError(err instanceof Error ? err.message : String(err));
	}
	logger.info(
		`Service pinned via API: service=${found.svc.id} tag=${body.data.tag} user=${caller.userId}`,
	);
	return Response.json(ImageVersionService.describe(found.svc));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	await ImageVersionService.unpin(found.svc);
	return Response.json(ImageVersionService.describe(found.svc));
};
