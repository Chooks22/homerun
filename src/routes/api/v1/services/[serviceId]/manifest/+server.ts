import { ServiceDTO } from "#lib/dto/service-dto.js";
import { manifestFromRequest } from "#lib/server/manifest.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import {
	ManifestError,
	ManifestService,
	manifestScopeFor,
} from "#lib/services/manifest.service.js";

export const PUT = async ({ params, request, locals, url }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const service = await ServiceDTO.get(params.serviceId);
	if (!service) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	const parsed = await manifestFromRequest(request);
	if ("errors" in parsed) {
		return Response.json(
			{ error: "Invalid manifest", errors: parsed.errors },
			{ status: 400 },
		);
	}
	try {
		const result = await ManifestService.apply(
			service,
			parsed.manifest,
			manifestScopeFor(service.toJSON()),
			{ userId: locals.user.id },
		);
		if (url.searchParams.get("deploy") !== "true") {
			return Response.json(result);
		}
		const { deploymentId } = await DeploymentService.enqueueDeploy({
			svc: service,
			userId: locals.user.id,
		});
		return Response.json({ ...result, deploymentId }, { status: 202 });
	} catch (error) {
		if (error instanceof ManifestError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
};
