import { apiCaller, readApiBody } from "#lib/server/api-route.js";
import { versionedService } from "#lib/server/service-version-api.js";
import { serviceVersionWatchApiBody } from "#lib/server/validation/operations-api.js";
import { ImageVersionService } from "#lib/services/image-version.service.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	return Response.json(ImageVersionService.describe(found.svc));
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	const body = await readApiBody(request, serviceVersionWatchApiBody);
	if ("response" in body) {
		return body.response;
	}
	await ImageVersionService.setWatch(found.svc, body.data);
	return Response.json(ImageVersionService.describe(found.svc));
};
