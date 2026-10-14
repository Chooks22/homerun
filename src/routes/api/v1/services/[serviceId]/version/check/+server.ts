import { apiCaller, apiError } from "#lib/server/api-route.js";
import { versionedService } from "#lib/server/service-version-api.js";
import { ImageVersionService } from "#lib/services/image-version.service.js";

export const POST = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const found = await versionedService(params.serviceId);
	if ("refused" in found) {
		return found.refused;
	}
	const state = await ImageVersionService.check(found.svc, {
		background: true,
	});
	if (state?.error) {
		return apiError(state.error, 502);
	}
	return Response.json(ImageVersionService.describe(found.svc));
};
