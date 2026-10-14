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
	try {
		await ImageVersionService.applyUpdate(found.svc, caller.userId);
	} catch (err) {
		return apiError(err instanceof Error ? err.message : String(err), 409);
	}
	return Response.json(ImageVersionService.describe(found.svc), {
		status: 202,
	});
};
